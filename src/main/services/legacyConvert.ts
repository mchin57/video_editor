/**
 * Convert legacy projects (schema < 24, media in the old global store) into
 * project folders — the I/O around `legacyPlan.ts`. @see docs/PROJECT-FOLDERS.md
 * "Migration".
 *
 * Nothing here deletes user data: the legacy `.reel` is renamed to
 * `.reel-legacy`, originals are LINKED (copied across volumes), and the old
 * store is left alone until `deleteLegacyStore` — which the batch offers only
 * when every original was found.
 */

import { existsSync, promises as fsp, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MediaAsset } from '@shared/media'
import { migrateProject } from '@shared/project'
import { getDataDir } from '../config'
import { linkOrCopy, copyAtomic } from './linkOrCopy'
import { replaceFile } from './atomicWrite'
import { hashFile } from './mediaStore'
import { assetJsonPath, autosavePath, cacheDir, docPath, mediaDir, originalName } from './projectLayout'
import {
  adoptAction,
  conversionFolder,
  isLegacyDoc,
  isReelFile,
  LEGACY_CACHE_FILES,
  LEGACY_STORE_DIRS,
  legacyBackupPath,
  legacyIdsIn,
  type ConversionReport
} from './legacyPlan'

const legacyStore = (): string => join(getDataDir(), 'media')

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Hash per (path, size, mtime) across a batch: two projects that share
 *  footage hash it once. */
const hashMemo = new Map<string, string>()
async function hashOf(path: string): Promise<string | null> {
  try {
    const s = await fsp.stat(path)
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

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await replaceFile(path, JSON.stringify(data, null, 2))
}

/**
 * Bring every store asset a legacy document mentions into `root`: the
 * original (if it still exists with its import-time bytes), its record,
 * transcript and derived files. Fills the report's counts.
 */
async function adoptMedia(root: string, docText: string, report: ConversionReport): Promise<void> {
  const store = legacyStore()
  for (const id of legacyIdsIn(docText, listDir(store))) {
    if (existsSync(assetJsonPath(root, id))) continue // already adopted (a re-run)
    let rec: MediaAsset
    try {
      rec = JSON.parse(await fsp.readFile(join(store, id, 'asset.json'), 'utf8')) as MediaAsset
    } catch {
      continue // no record: the clip shows as unknown media, as it did before
    }
    const action = adoptAction(
      rec.originalPath,
      { exists: existsSync(rec.originalPath), hash: await hashOf(rec.originalPath) },
      id,
      getDataDir()
    )
    await fsp.mkdir(mediaDir(root, id), { recursive: true })
    const file = originalName(rec.originalPath)
    const original = join(mediaDir(root, id), file)
    const { originalPath, ...fields } = rec
    const next: Record<string, unknown> = { ...fields, file, hash: id, proxyReady: false }
    if (action.kind === 'adopt') {
      const placed = existsSync(original) ? 'link' : await linkOrCopy(action.from, original)
      if (placed === 'link') report.linked++
      else report.copied++
      const s = await fsp.stat(original)
      Object.assign(next, {
        storage: action.generated ? 'generated' : placed,
        sourcePath: action.generated ? null : originalPath,
        size: s.size,
        mtimeMs: s.mtimeMs
      })
    } else {
      // Recorded without its file: the Library shows it missing, and
      // re-importing the same footage from anywhere relinks it.
      report.missing.push(rec.fileName)
      Object.assign(next, { storage: 'link', sourcePath: originalPath })
    }
    await writeJsonAtomic(assetJsonPath(root, id), next)
    const transcript = join(store, id, 'transcript.json')
    if (existsSync(transcript)) {
      await copyAtomic(transcript, join(mediaDir(root, id), 'transcript.json')).catch(() => {})
    }
    for (const name of LEGACY_CACHE_FILES) {
      const src = join(store, id, name)
      if (!existsSync(src)) continue
      await fsp.mkdir(cacheDir(root, id), { recursive: true })
      // Link only: the old store is deleted afterwards, and across volumes a
      // rebuild beats copying derived files.
      await fsp.link(src, join(cacheDir(root, id), name)).catch(() => {})
    }
  }
}

/**
 * Convert one legacy `.reel` into a project folder (in place when it sits
 * alone in its own folder, else a new `<Name>/` beside it). Returns the
 * report; `report.to` is the new `.reel`.
 */
export async function convertLegacyProject(
  reelPath: string,
  opts: { sharedDirs?: string[] } = {}
): Promise<ConversionReport> {
  const report: ConversionReport = { from: reelPath, to: null, linked: 0, copied: 0, missing: [] }
  const text = await fsp.readFile(reelPath, 'utf8')
  const raw = JSON.parse(text) as unknown
  if (!isLegacyDoc(raw)) throw new Error('This project is already a project folder.')
  const dir = dirname(reelPath)
  const shared = (opts.sharedDirs ?? []).some((d) => d.toLowerCase() === dir.toLowerCase())
  const { root } = conversionFolder(reelPath, {
    reelsInDir: listDir(dir).filter(isReelFile).length,
    dirIsShared: shared,
    taken: (folder) => existsSync(folder)
  })
  await fsp.mkdir(root, { recursive: true })
  await adoptMedia(root, text, report)
  // Back up the legacy file FIRST: in place it may already have the target name.
  await fsp.rename(reelPath, legacyBackupPath(reelPath))
  const project = { ...migrateProject(raw), name: basename(root), updatedAt: new Date().toISOString() }
  await writeJsonAtomic(docPath(root), project)
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
 * The batch: convert every legacy project under `dir`. One failure doesn't
 * stop the rest; each gets its own report line.
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
      reports.push({ from: path, to: null, linked: 0, copied: 0, missing: [], error: error instanceof Error ? error.message : String(error) })
    }
    onProgress?.(i + 1, reels.length)
  }
  return reports
}

/**
 * First launch after the update: the old working copy (`projects/current.json`)
 * becomes the unsaved scratch project, its media adopted like any conversion.
 * The old file is kept as `current.json.legacy`. No-op when there is none.
 */
export async function convertWorkingCopy(scratch: string): Promise<ConversionReport | null> {
  const current = join(getDataDir(), 'projects', 'current.json')
  if (!existsSync(current)) return null
  const report: ConversionReport = { from: current, to: null, linked: 0, copied: 0, missing: [] }
  const text = await fsp.readFile(current, 'utf8')
  await fsp.mkdir(scratch, { recursive: true })
  await adoptMedia(scratch, text, report)
  await writeJsonAtomic(autosavePath(scratch), migrateProject(JSON.parse(text)))
  await fsp.rename(current, `${current}.legacy`)
  return report
}

/** The old global store's size: `total` on disk under its names, and `freed`
 *  — what deleting it actually releases (files no converted project links to;
 *  a linked file's bytes stay with the project). Both 0 once deleted. */
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

/** Delete the old global store (after the user confirmed). Converted projects
 *  hold their own links, so nothing they use goes with it. */
export async function deleteLegacyStore(): Promise<void> {
  for (const name of LEGACY_STORE_DIRS) {
    await fsp.rm(join(getDataDir(), name), { recursive: true, force: true })
  }
}
