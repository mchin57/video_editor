/**
 * Convert legacy projects (schema < 24, media in the old global store) into
 * project folders whose library POINTS at the originals — the I/O around
 * `legacyPlan.ts`. @see docs/MEDIA-POINTERS.md "Migration".
 *
 * Nothing here touches the user's footage: it is never moved, renamed, copied
 * or written. App-generated originals (which lived in the old store) are
 * COPIED into `generated/`, transcripts into `transcripts/`, derived files
 * linked (or copied) into `cache/`. The legacy `.reel` is renamed to
 * `.reel-legacy`, and the old store is left alone until `deleteLegacyStore` —
 * which may only be offered once `remainingLegacyProjects` is empty.
 */

import { app } from 'electron'
import { existsSync, promises as fsp, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import type { MediaRecord, ProbeInfo, MediaKind } from '@shared/media'
import { kindOfFile, reconcileKind } from '@shared/media'
import { migrateProject, PROJECT_VERSION } from '@shared/project'
import { getDataDir } from '../config'
import { replaceFile } from './atomicWrite'
import { probeFile } from './ffprobe'
import { fingerprintFile, UNKNOWN_FINGERPRINT } from './fingerprint'
import { isMediaPath } from './importScan'
import { copyAtomic, linkOrCopy } from './linkOrCopy'
import { hashFile } from './mediaStore'
import { toRelativePath } from './mediaRef'
import { ensureProjectFolders } from './projectStore'
import {
  cacheDir,
  docPath,
  generatedRoot,
  safeFileName,
  transcriptPath,
  uniqueFileName
} from './projectLayout'
import {
  conversionFolder,
  generatedFileName,
  idsToConvert,
  isGeneratedPath,
  isLegacyDoc,
  isReelFile,
  isSharedDir,
  LEGACY_CACHE_FILES,
  LEGACY_STORE_DIRS,
  legacyBackupPath,
  nearbyOrder,
  noRecordLine,
  type ConversionReport
} from './legacyPlan'

export type { ConversionReport } from './legacyPlan'
export { reportLine } from './legacyPlan'

/** An old store record (`<data>/media/<id>/asset.json`) — the fields we read. */
interface StoreRecord {
  id: string
  fileName: string
  /** Absolute; under the data dir for app-generated media. */
  originalPath: string
  importedAt: string
  probe: ProbeInfo
  kind?: MediaKind
}

const legacyStore = (): string => join(getDataDir(), 'media')

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Folders a `.reel` can sit in loose, beside unrelated files — never adopted
 *  as one project's folder. */
function userFolders(): string[] {
  const names = ['home', 'documents', 'desktop', 'downloads'] as const
  return names.flatMap((n) => {
    try {
      return [app.getPath(n)]
    } catch {
      return []
    }
  })
}

/** Old-scheme content hash per (path, size, mtime), shared across a batch:
 *  two projects that use the same footage hash it once. */
const hashMemo = new Map<string, string>()
async function hashOf(path: string): Promise<string | null> {
  try {
    const s = await fsp.stat(path)
    if (!s.isFile()) return null
    const key = `${path}|${s.size}|${s.mtimeMs}`
    let hash = hashMemo.get(key)
    if (!hash) {
      hash = await hashFile(path)
      hashMemo.set(key, hash)
    }
    return hash
  } catch {
    return null
  }
}

async function readStoreRecord(id: string): Promise<StoreRecord | null> {
  try {
    const rec = JSON.parse(await fsp.readFile(join(legacyStore(), id, 'asset.json'), 'utf8')) as StoreRecord
    return typeof rec.originalPath === 'string' ? rec : null
  } catch {
    return null
  }
}

/** One conversion's working state. */
interface Ctx {
  root: string
  /** The legacy `.reel`'s own folder — where moved footage is looked for. */
  reelDir: string
  report: ConversionReport
  nearby?: string[]
}

/** Media files directly in the `.reel`'s folder (non-recursive, junk skipped). */
async function nearbyFiles(ctx: Ctx): Promise<string[]> {
  if (!ctx.nearby) {
    const out: string[] = []
    for (const ent of await fsp.readdir(ctx.reelDir, { withFileTypes: true }).catch(() => [])) {
      if (!ent.isFile() || ent.name.startsWith('._') || !isMediaPath(ent.name)) continue
      out.push(join(ctx.reelDir, ent.name))
    }
    ctx.nearby = out.sort()
  }
  return ctx.nearby
}

/** A file beside the legacy `.reel` whose old content hash is `id` (the
 *  footage moved next to its project after import), else null. */
async function findNearby(ctx: Ctx, id: string, fileName?: string): Promise<string | null> {
  for (const path of nearbyOrder(await nearbyFiles(ctx), fileName)) {
    if ((await hashOf(path)) === id) return path
  }
  return null
}

const unknown = (): MediaRecord['fingerprint'] => ({ ...UNKNOWN_FINGERPRINT })

/** A record pointing at `path` (which exists and is the right content). */
async function pointingAt(ctx: Ctx, base: Omit<MediaRecord, 'relativePath' | 'absolutePath' | 'fingerprint'>, path: string): Promise<MediaRecord> {
  ctx.report.found++
  return {
    ...base,
    relativePath: toRelativePath(ctx.root, path),
    absolutePath: path,
    fingerprint: await fingerprintFile(path)
  }
}

/** A record for an original that couldn't be located: it shows Missing, and
 *  Relink ("Update path anyway") fills in the real fingerprint. */
function missingRecord(ctx: Ctx, base: Omit<MediaRecord, 'relativePath' | 'absolutePath' | 'fingerprint'>, oldPath: string): MediaRecord {
  ctx.report.missing.push(base.fileName)
  return { ...base, relativePath: toRelativePath(ctx.root, oldPath), absolutePath: oldPath, fingerprint: unknown() }
}

/** The user's footage: where the store says, if it still holds the imported
 *  bytes; else beside the legacy `.reel`; else missing. */
async function footageRecord(ctx: Ctx, rec: StoreRecord, base: Omit<MediaRecord, 'relativePath' | 'absolutePath' | 'fingerprint'>): Promise<MediaRecord> {
  const path = (await hashOf(rec.originalPath)) === rec.id ? rec.originalPath : await findNearby(ctx, rec.id, rec.fileName)
  return path ? pointingAt(ctx, base, path) : missingRecord(ctx, base, rec.originalPath)
}

/** App-generated media: copied into `generated/` under a legal, unique name.
 *  A re-run after a failed attempt reuses its own earlier copy. */
async function generatedRecord(ctx: Ctx, rec: StoreRecord, base: Omit<MediaRecord, 'relativePath' | 'absolutePath' | 'fingerprint'>): Promise<MediaRecord> {
  const gen = { ...base, generated: true }
  const srcHash = await hashOf(rec.originalPath)
  // Its file stays where the old store had it (gone); generated: true keeps it
  // classed as editor-made, and nothing deletes outside generated/.
  if (!srcHash) return missingRecord(ctx, gen, rec.originalPath)
  const dir = generatedRoot(ctx.root)
  const name = generatedFileName(safeFileName(rec.fileName), rec.originalPath)
  let dest = join(dir, name)
  if ((await hashOf(dest)) !== srcHash) {
    dest = join(dir, uniqueFileName(name, (n) => existsSync(join(dir, n))))
    await copyAtomic(rec.originalPath, dest)
    ctx.report.copied++
  }
  return pointingAt(ctx, gen, dest)
}

/**
 * An id the old store has no record of (deleted, or never written). Only
 * footage sitting beside the `.reel` can be recovered — probed afresh. Not
 * found: there's nothing to build a record from, so the id stays in the
 * document unrecorded (the clip shows as unknown media). Re-importing that
 * footage later won't reconnect it: new imports get fingerprint-derived ids,
 * never this old content-hash id. Accepted — the old app showed it broken too.
 */
async function unrecordedRecord(ctx: Ctx, id: string): Promise<MediaRecord | null> {
  const path = await findNearby(ctx, id)
  if (!path) return null
  const probe = await probeFile(path)
  const base = {
    id,
    fileName: basename(path),
    importedAt: new Date().toISOString(),
    probe,
    kind: kindOfFile(path, probe)
  }
  return pointingAt(ctx, base, path)
}

/** Carry the transcript and derived files of a store entry into the project.
 *  Derived files are best-effort: the cache rebuilds anything missing. */
async function carryFiles(root: string, id: string): Promise<void> {
  const from = join(legacyStore(), id)
  const transcript = join(from, 'transcript.json')
  if (existsSync(transcript) && !existsSync(transcriptPath(root, id))) {
    await copyAtomic(transcript, transcriptPath(root, id))
  }
  for (const name of LEGACY_CACHE_FILES) {
    const src = join(from, name)
    if (!existsSync(src)) continue
    await fsp.mkdir(cacheDir(root, id), { recursive: true }).catch(() => {})
    await linkOrCopy(src, join(cacheDir(root, id), name)).catch(() => {})
  }
}

/**
 * Convert one legacy `.reel` into a project folder (in place when it sits
 * alone in its own folder that isn't a shared one, else a new `<Name>/`
 * beside it). Every clip keeps its old id. `sharedDirs` adds folders (the
 * batch root) to the built-in shared ones (home, Documents, Desktop,
 * Downloads). Throws on an unreadable or non-legacy file; `report.to` is the
 * new `.reel`.
 */
export async function convertLegacyProject(
  reelPath: string,
  opts: { sharedDirs?: string[] } = {}
): Promise<ConversionReport> {
  const report: ConversionReport = { from: reelPath, to: null, found: 0, copied: 0, missing: [] }
  const text = await fsp.readFile(reelPath, 'utf8')
  const raw = JSON.parse(text) as unknown
  if (!isLegacyDoc(raw)) throw new Error('This project is already a project folder.')
  const doc = migrateProject(raw)
  const reelDir = dirname(reelPath)
  const { root } = conversionFolder(reelPath, {
    reelsInDir: listDir(reelDir).filter(isReelFile).length,
    dirIsShared: isSharedDir(reelDir, [...userFolders(), ...(opts.sharedDirs ?? [])]),
    taken: (folder) => existsSync(folder)
  })
  await fsp.mkdir(root, { recursive: true })
  await ensureProjectFolders(root) // marks a generated/ it creates, so cleanup may tidy it later

  const ctx: Ctx = { root, reelDir, report }
  const dataDir = getDataDir()
  const library: MediaRecord[] = []
  let unrecorded = 0
  for (const id of idsToConvert(text, listDir(legacyStore()), doc.mediaIds)) {
    const rec = await readStoreRecord(id)
    let record: MediaRecord | null
    if (rec) {
      const base = {
        id,
        fileName: rec.fileName,
        importedAt: rec.importedAt,
        probe: rec.probe,
        kind: reconcileKind(rec.kind, rec.probe)
      }
      const ownRec = { ...rec, id }
      record = isGeneratedPath(rec.originalPath, dataDir)
        ? await generatedRecord(ctx, ownRec, base)
        : await footageRecord(ctx, ownRec, base)
    } else {
      record = await unrecordedRecord(ctx, id)
      if (!record) unrecorded++
    }
    if (!record) continue
    library.push(record)
    await carryFiles(root, id).catch(() => {})
  }
  if (unrecorded) report.missing.push(noRecordLine(unrecorded))

  // Back up the legacy file FIRST: in place it may already have the target name.
  const backup = legacyBackupPath(reelPath)
  await fsp.rename(reelPath, backup)
  try {
    const saved = { ...doc, name: basename(root), version: PROJECT_VERSION, updatedAt: new Date().toISOString(), library }
    await replaceFile(docPath(root), JSON.stringify(saved, null, 2))
  } catch (error) {
    await fsp.rename(backup, reelPath).catch(() => {})
    throw error
  }
  report.to = docPath(root)
  return report
}

/** Every legacy `.reel` in `dir` and its immediate subfolders (the owner's
 *  Reels layout: loose files plus one folder per project). */
export function findLegacyReels(dir: string): string[] {
  const found: string[] = []
  const consider = (path: string): void => {
    try {
      if (isLegacyDoc(JSON.parse(readFileSync(path, 'utf8')))) found.push(path)
    } catch {
      /* not a readable project: leave it alone */
    }
  }
  const isDir = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
  for (const name of listDir(dir)) {
    const path = join(dir, name)
    if (isReelFile(name)) consider(path)
    else if (isDir(path)) for (const inner of listDir(path)) if (isReelFile(inner)) consider(join(path, inner))
  }
  return found
}

/**
 * Every legacy `.reel` still under any of `dirs` (each scanned like a batch
 * folder), deduped case-insensitively. The old store may be deleted ONLY when
 * this is empty: a batch that converted one folder cleanly says nothing about
 * the rest (that mistake once deleted the owner's store).
 */
export function remainingLegacyProjects(dirs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs) {
    for (const path of findLegacyReels(dir)) {
      const key = normalize(path).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(path)
    }
  }
  return out
}

/**
 * The batch: convert every legacy project under `dir`. One failure doesn't
 * stop the rest; each gets its own report.
 */
export async function convertLegacyFolder(
  dir: string,
  onProgress?: (done: number, total: number) => void
): Promise<ConversionReport[]> {
  const reels = findLegacyReels(dir)
  const reports: ConversionReport[] = []
  for (const [i, path] of reels.entries()) {
    try {
      reports.push(await convertLegacyProject(path, { sharedDirs: [dir] }))
    } catch (error) {
      reports.push({
        from: path,
        to: null,
        found: 0,
        copied: 0,
        missing: [],
        error: error instanceof Error ? error.message : String(error)
      })
    }
    onProgress?.(i + 1, reels.length)
  }
  return reports
}

/** The old global store's size: `total` on disk under its names, and `freed`
 *  — what deleting it actually releases (files no converted project links to;
 *  a linked cache file's bytes stay with the project). Both 0 once deleted. */
export async function legacyStoreBytes(): Promise<{ total: number; freed: number }> {
  let total = 0
  let freed = 0
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(p)
        continue
      }
      const s = await fsp.stat(p).catch(() => null)
      if (!s) continue
      total += s.size
      if (s.nlink <= 1) freed += s.size
    }
  }
  for (const name of LEGACY_STORE_DIRS) await walk(join(getDataDir(), name))
  return { total, freed }
}

/** Delete the old global store (after the user confirmed, and only when
 *  `remainingLegacyProjects` is empty). Converted projects hold their own
 *  generated copies, transcripts and cache links, and point at the user's
 *  footage where it lives — nothing they use goes with it. */
export async function deleteLegacyStore(): Promise<void> {
  for (const name of LEGACY_STORE_DIRS) {
    await fsp.rm(join(getDataDir(), name), { recursive: true, force: true })
  }
}
