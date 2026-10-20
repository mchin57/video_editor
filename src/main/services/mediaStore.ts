/**
 * The open project's media library (docs/MEDIA-POINTERS.md). A library item
 * POINTS at its original where the user keeps it — nothing is copied or
 * linked. Its record (paths + fingerprint + probe) lives in main's in-memory
 * library (`library.ts`) and reaches disk only when the project is saved.
 * `cache/<id>/` holds the derived files (proxy, thumb, waveform, display PNG),
 * rebuilt on demand whenever they are missing; `generated/` holds media the
 * editor made; `transcripts/` holds whisper output.
 *
 * Paths come from `projectLayout`; the folder, library and per-project job
 * state from the `ProjectSession`. Every public entry point takes the session
 * (default: the open project's, read once at the call), so a job outlives a
 * project switch in the project it started in.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import { basename, dirname, join, parse } from 'node:path'
import type { FingerprintField, MediaAsset, MediaKind, MediaRecord } from '@shared/media'
import type { RelinkResult } from '@shared/ipc'
import { isAudioAsset, isImageAsset, isUnknownClip, kindOfFile, normalizeDescription } from '@shared/media'
import { getSubdir } from '../config'
import { probeFile } from './ffprobe'
import { generateProxy, generateAlphaProxy } from './proxy'
import { generateThumbnail } from './thumbnail'
import { generateDisplayImage } from './image'
import { detectMonoFoldChannel, extractAudio, generateAudioProxy, generateWaveform } from './audio'
import { activeJobUsing, createJob, failJob, finishJob } from './jobs'
import { splitFileName, validateFileStem } from '@shared/fileName'
import { moveFile } from './linkOrCopy'
import { requireSession, type ProjectSession } from './projectSession'
import { unusableMessage } from './mediaHealth'
import { fingerprintDiff, fingerprintId, isUnknownFingerprint, sameFingerprint } from './fingerprint'
import { toRelativePath } from './mediaRef'
import type { LibraryEntry } from './library'
import {
  cacheDir,
  cachePath,
  generatedRoot,
  renameTarget,
  safeFileName,
  transcriptPath,
  uniqueFileName
} from './projectLayout'
import type { AudioFxSettings } from '@shared/audioFx'
import { fxLabel } from '@shared/audioFx'
import { renderAudioFx } from './audioFx'
import { forgetLoudnessFailure, kickLoudness, loudnessPassReading, type LoudnessSource } from './loudness'
import { createLogger } from '@shared/log'

const log = createLogger('media')

/** Full-content hash (first 12 hex of sha1) — the id scheme before
 *  fingerprints. Only legacy conversion still needs it. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 12)))
  })
}

const proxyPath = (r: string, id: string): string => cachePath(r, id, 'proxy.mp4')
/** Alpha-preserving proxy (VP9 WebM) for background-removed clips. */
const alphaProxyPath = (r: string, id: string): string => cachePath(r, id, 'proxy.webm')
const audioProxyPath = (r: string, id: string): string => cachePath(r, id, 'audio.m4a')
const imagePath = (r: string, id: string): string => cachePath(r, id, 'image.png')
const waveformPath = (r: string, id: string): string => cachePath(r, id, 'waveform.png')
const thumbPath = (r: string, id: string): string => cachePath(r, id, 'thumb.jpg')

/** Whether a video asset carries an alpha channel (background-removed clip). */
const isAlphaVideo = (a: MediaAsset): boolean => !!a.probe.video?.hasAlpha

/** The "ready to use" artifact for an asset: image PNG, audio bed, or video proxy
 *  (a VP9 WebM for alpha clips so preview keeps transparency, else an H.264 mp4). */
const playableProxyPath = (r: string, a: MediaAsset): string =>
  isImageAsset(a)
    ? imagePath(r, a.id)
    : isAudioAsset(a)
      ? audioProxyPath(r, a.id)
      : isAlphaVideo(a)
        ? alphaProxyPath(r, a.id)
        : proxyPath(r, a.id)

/*
 * Every generated file here is gated on EXISTENCE (a present proxy.mp4 means
 * "ready"; a present thumb.jpg means "don't regenerate"), so two rules hold:
 * the generators write atomically (`writeAtomically` — the final name never
 * refers to a half-written file), and each file has at most one generator in
 * flight. The second matters because `hydrate` runs on EVERY library refetch
 * and would otherwise race the import's own generation onto the same partial.
 * Existence-gating is also what makes cache/ disposable: delete it and every
 * file comes back the next time it is asked for.
 */
// The single-flight maps and the failure memory (artifactFailed, proxyFailed)
// live on the ProjectSession: the import flight is keyed by media id, which is
// the same in every project holding the same file.

/** Forget the failures remembered for one asset's cache dir (proxy + artifacts). */
function forgetFailures(s: ProjectSession, dir: string): void {
  for (const out of [...s.artifactFailed]) if (out.startsWith(dir)) s.artifactFailed.delete(out)
  s.proxyFailed.delete(dir)
  forgetLoudnessFailure(s, dir)
}

/** Best-effort derived file: skipped if present, generated once however many
 *  callers race for it, and never throws (a missing thumb must not fail an import). */
async function makeArtifact(
  s: ProjectSession,
  out: string,
  what: string,
  id: string,
  generate: (out: string) => Promise<void>
): Promise<void> {
  if (existsSync(out) || s.artifactFailed.has(out)) return
  await s.artifactFlight(out, async () => {
    try {
      await fsp.mkdir(join(out, '..'), { recursive: true })
      await generate(out)
    } catch (error) {
      s.artifactFailed.add(out)
      log.error(`${what} failed for ${id}`, error)
    }
  })
}

/** Best-effort first-frame thumbnail; never fails the import if it errors. */
async function makeThumb(s: ProjectSession, asset: MediaAsset): Promise<void> {
  if (!asset.probe.video) return
  await makeArtifact(s, thumbPath(s.root, asset.id), 'thumbnail', asset.id, (out) =>
    generateThumbnail(asset.originalPath, out, asset.probe, isImageAsset(asset))
  )
}

/** Best-effort waveform for any asset with audio (video included, for the
 *  audio lane when its audio is extracted onto the track). */
async function makeWaveform(s: ProjectSession, asset: MediaAsset): Promise<void> {
  if (!asset.probe.audio) return
  await makeArtifact(s, waveformPath(s.root, asset.id), 'waveform', asset.id, (out) =>
    generateWaveform(asset.originalPath, out, asset.probe.durationSec)
  )
}

/** What the loudness pass needs to know about an asset. */
const loudnessSource = (asset: MediaAsset): LoudnessSource => ({
  id: asset.id,
  path: asset.status === 'ok' ? asset.originalPath : null,
  hasAudio: !!asset.probe.audio,
  foldChannel: asset.probe.audio?.monoFoldChannel ?? null
})

/** Best-effort display PNG (alpha-preserving) for an imported image. */
async function makeImage(s: ProjectSession, asset: MediaAsset): Promise<void> {
  if (!isImageAsset(asset)) return
  await makeArtifact(s, imagePath(s.root, asset.id), 'display image', asset.id, (out) =>
    generateDisplayImage(asset.originalPath, out)
  )
}

/** A library entry as the app uses it (runtime facts filled in from disk). */
function toAsset(s: ProjectSession, entry: LibraryEntry): MediaAsset {
  const asset: MediaAsset = {
    ...entry.record,
    originalPath: entry.path ?? entry.record.absolutePath,
    status: entry.path ? 'ok' : 'missing',
    proxyReady: false,
    // A transcript a forced relink made stale is hidden until Save deletes it.
    transcribed: !entry.staleTranscript && existsSync(transcriptPath(s.root, entry.record.id)),
    // Changes exactly when the content does, so the renderer's media URLs do too.
    rev: fingerprintId(entry.record.fingerprint)
  }
  asset.proxyReady = existsSync(playableProxyPath(s.root, asset))
  return asset
}

/** An asset of the open project, its original located now (null = unknown id). */
async function readAsset(s: ProjectSession, id: string): Promise<MediaAsset | null> {
  const res = await s.library.resolveEntry(id)
  return res ? toAsset(s, res.entry) : null
}

// The public entry points below take the session last; the default is the open
// project's, read when the function is CALLED. A long job passes the one it
// started under, so a project switch mid-job doesn't move it.

/** A single asset of the project, its original located now. */
export const getAsset = (id: string, s: ProjectSession = requireSession()): Promise<MediaAsset | null> =>
  readAsset(s, id)

/** Where an asset's transcript lives (project-owned: slow to rebuild). */
export const transcriptFile = (id: string, s: ProjectSession = requireSession()): string => transcriptPath(s.root, id)

/** Scratch dir for an asset's intermediate files (whisper's 16 kHz wav) — in
 *  the disposable cache, created on demand. */
export async function scratchDirFor(id: string, s: ProjectSession = requireSession()): Promise<string> {
  const dir = cacheDir(s.root, id)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** The audio proxy for an asset if it exists (export prefers it), else null. */
export function audioProxyIfReady(id: string, s: ProjectSession = requireSession()): string | null {
  const p = audioProxyPath(s.root, id)
  return existsSync(p) ? p : null
}

/** Absolute path to an image asset's display PNG, rebuilt first if the cache
 *  lost it (used by preview + export). */
export async function ensureImagePath(id: string, s: ProjectSession = requireSession()): Promise<string> {
  const asset = await readAsset(s, id)
  if (asset?.status === 'ok') await makeImage(s, asset)
  return imagePath(s.root, id)
}

/** The asset, if its original was found; else a clear error (jobs call this
 *  instead of letting ffmpeg fail on a missing file). */
export async function requireUsable(id: string, s: ProjectSession = requireSession()): Promise<MediaAsset> {
  const asset = await readAsset(s, id)
  if (!asset) throw new Error('That media is no longer in the library.')
  if (asset.status !== 'ok') throw new Error(unusableMessage([{ fileName: asset.fileName, status: asset.status! }]))
  return asset
}

/** Throw (naming every file) unless all these assets are usable: export's gate. */
export async function assertMediaUsable(ids: string[], s: ProjectSession = requireSession()): Promise<void> {
  const items: { fileName: string; status: 'ok' | 'missing' }[] = []
  for (const id of new Set(ids)) {
    const asset = await readAsset(s, id)
    if (!asset) continue // the exporter already skips unknown media
    items.push({ fileName: asset.fileName, status: asset.status === 'ok' ? 'ok' : 'missing' })
  }
  if (items.some((i) => i.status !== 'ok')) throw new Error(unusableMessage(items))
}

/** Point a record at `path` (where its content was just found): both paths
 *  follow it, and it counts as generated exactly when it lives in the
 *  project's `generated/` (Save As carries those files along). */
function pointAt(r: string, record: MediaRecord, path: string): MediaRecord {
  const relativePath = toRelativePath(r, path)
  const { generated, ...rest } = record
  const inGenerated = !!relativePath && relativePath.toLowerCase().startsWith('generated/')
  return { ...rest, absolutePath: path, relativePath, ...(inGenerated ? { generated: true } : {}) }
}

/** How a picked file compares with a clip's fingerprint, for the Relink warning. */
export interface RelinkCheck {
  fileName: string
  matches: boolean
  /** The clip was never fingerprinted (converted after its file was gone). */
  unknown: boolean
  /** Nothing records which file the clip was (a placeholder: unknownMedia.ts). */
  placeholder: boolean
  /** The fields that differ (empty when it matches). */
  differs: FingerprintField[]
  recordedSize: number
  foundSize: number
}

export async function relinkCheck(
  id: string,
  srcPath: string,
  s: ProjectSession = requireSession()
): Promise<RelinkCheck> {
  const entry = s.library.getEntry(id)
  if (!entry) throw new Error('That media is no longer in the library.')
  const recorded = entry.record.fingerprint
  const found = await s.library.fingerprintOf(srcPath)
  const unknown = isUnknownFingerprint(recorded)
  const differs = fingerprintDiff(recorded, found)
  return {
    fileName: entry.record.fileName,
    matches: !unknown && differs.length === 0,
    unknown,
    placeholder: isUnknownClip(entry.record),
    differs,
    recordedSize: recorded.size,
    foundSize: found.size
  }
}

/**
 * "Relink": point `id` at `srcPath` (docs/MEDIA-POINTERS.md "Relink"). A file
 * that doesn't match the clip's fingerprint is taken only with `force` — the
 * user's "Update path anyway" — and then the clip becomes that file: its
 * fingerprint and probe follow it, and its cache and transcript go (they
 * describe the old content). A change of length is reported (`cutsReset`) so
 * the renderer resets the clip's cuts. Afterwards the picked file's folder is
 * searched for the project's other missing clips (relink one, fix the rest).
 */
export async function relinkMedia(
  id: string,
  srcPath: string,
  force = false,
  s: ProjectSession = requireSession()
): Promise<RelinkResult> {
  const r = s.root
  const entry = s.library.getEntry(id)
  if (!entry) throw new Error('That media is no longer in the library.')
  const fp = await s.library.fingerprintOf(srcPath)
  let cutsReset = false
  if (sameFingerprint(fp, entry.record.fingerprint)) {
    s.library.putEntry(pointAt(r, entry.record, srcPath), srcPath, r)
  } else {
    if (!force) throw new Error(`That file isn't the same footage as "${entry.record.fileName}".`)
    const probe = await probeFile(srcPath)
    if (probe.audio?.channels === 2) probe.audio.monoFoldChannel = await detectMonoFoldChannel(srcPath)
    // Cuts reset only when the old length was KNOWN and differs: a clip never
    // fingerprinted has no real length to compare, so its cuts stay.
    const lengthKnown = !isUnknownFingerprint(entry.record.fingerprint)
    cutsReset = lengthKnown && Math.abs(probe.durationSec - entry.record.probe.durationSec) > 0.01
    // A placeholder takes the file's name and kind; a known clip keeps its own.
    const identity = isUnknownClip(entry.record)
      ? { fileName: basename(srcPath), kind: kindOfFile(srcPath, probe) }
      : {}
    // The cache is disposable — rebuild it from the new file now. The
    // transcript isn't: hide it, and let Save delete it (not saving brings
    // the old record back, and with it the transcript that matches).
    await fsp.rm(cacheDir(r, id), { recursive: true, force: true })
    forgetFailures(s, cacheDir(r, id)) // new content: its derived files get a fresh try
    s.library.putEntry({ ...pointAt(r, entry.record, srcPath), fingerprint: fp, probe, ...identity }, srcPath, r)
    s.library.markTranscriptStale(id)
  }
  const asset = await hydrate(s, toAsset(s, s.library.getEntry(id)!))
  return { asset, cutsReset, alsoFound: await relinkSiblings(s, dirname(srcPath)) }
}

/** A failed `fs.rename` in words. Windows answers a file another program
 *  holds open (ffmpeg reading it, a player) with EBUSY — verified, see
 *  docs/FFMPEG-NOTES.md "Renaming a file ffmpeg is reading" — and a locked or
 *  protected one with EPERM / EACCES. The holder may be the editor itself:
 *  thumbnail, waveform, mono-fold and silence passes read originals right
 *  after an open or import without a job to refuse on. */
export function renameFailureMessage(error: unknown, fileName: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return `Windows wouldn't rename “${fileName}”: it's in use — by another program, or the editor is still reading it — or you don't have permission to change it. Try again in a moment, or close whatever else has it open.`
  }
  if (code === 'ENOENT') return `“${fileName}” is no longer where it was. Nothing was renamed.`
  return `Couldn't rename “${fileName}”: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Library Rename (docs/MEDIA-POINTERS.md "Rename"): the original file on disk
 * gets `stem` plus its own extension, in its own folder, and the library item
 * takes the same name. Refused — with nothing changed — for a missing or
 * unknown clip, an invalid name, a name already taken in that folder (a
 * case-only change of the same file is allowed), or while a job or a
 * loudness pass reads the file. The file is renamed FIRST; the record (`fileName` + both paths, via
 * `pointAt`) changes only once that succeeded. The fingerprint, id, cache and
 * transcript are untouched: the bytes are the same. The change is NOT
 * broadcast: the caller marks the library changed and saves.
 */
export async function renameMedia(id: string, stem: string, s: ProjectSession = requireSession()): Promise<MediaAsset> {
  const r = s.root
  const entry = s.library.getEntry(id)
  if (!entry) throw new Error('That media is no longer in the library.')
  if (isUnknownClip(entry.record)) throw new Error('This clip has no known file to rename. Relink it first.')
  const found = await s.library.resolveEntry(id)
  const from = found?.entry.path
  if (!found || !from)
    throw new Error(`“${entry.record.fileName}” is missing, so there is no file to rename. Relink it first.`)
  const current = basename(from)
  const reason = validateFileStem(stem, splitFileName(current).ext)
  if (reason) throw new Error(reason)
  const busy = activeJobUsing(id)
  if (busy) throw new Error(`“${current}” is in use by “${busy.label}”. Wait for it to finish, then rename.`)
  if (loudnessPassReading(s, id))
    throw new Error(`“${current}” is still being measured for volume levels. Try again in a moment.`)

  const target = renameTarget(from, stem)
  if (!target.unchanged) {
    // fs.rename REPLACES an existing target on Windows (verified), so a taken
    // name must be refused here. A case-only change "finds" the file itself.
    const there = await fsp.stat(target.path, { bigint: true }).catch(() => null)
    const self = there && target.caseOnly && (await fsp.stat(from, { bigint: true })).ino === there.ino
    if (there && !self) throw new Error(`A file named “${target.name}” already exists in that folder.`)
    try {
      await fsp.rename(from, target.path)
    } catch (error) {
      throw new Error(renameFailureMessage(error, current))
    }
  }
  const record = { ...pointAt(r, found.entry.record, target.path), fileName: target.name }
  // Quiet: the renderer marks the change and saves right after this returns
  // (docs/MEDIA-POINTERS.md "Rename").
  if (!target.unchanged || record.fileName !== found.entry.record.fileName)
    s.library.putEntry(record, target.path, r, true)
  return hydrate(s, toAsset(s, s.library.getEntry(id)!))
}

/**
 * Relink one, fix the rest: every other missing clip whose file is in `dir`
 * (matched by size, then fingerprint) is pointed at it. Returns their names.
 */
async function relinkSiblings(s: ProjectSession, dir: string): Promise<string[]> {
  const missing: LibraryEntry[] = []
  for (const entry of s.library.allEntries()) {
    if (isUnknownFingerprint(entry.record.fingerprint)) continue
    const res = await s.library.resolveEntry(entry.record.id)
    if (res && !res.entry.path) missing.push(res.entry)
  }
  if (!missing.length) return []
  const bySize = new Map<number, string[]>()
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name)
    const s = await fsp.stat(path).catch(() => null)
    if (!s?.isFile()) continue
    bySize.set(s.size, [...(bySize.get(s.size) ?? []), path])
  }
  const found: string[] = []
  for (const entry of missing) {
    for (const path of bySize.get(entry.record.fingerprint.size) ?? []) {
      const fp = await s.library.fingerprintOf(path).catch(() => null)
      if (!fp || !sameFingerprint(fp, entry.record.fingerprint)) continue
      s.library.putEntry(pointAt(s.root, entry.record, path), path, s.root)
      found.push(entry.record.fileName)
      break
    }
  }
  return found
}

/**
 * Set (or with '' clear) a library item's description. An unsaved change like
 * any other library edit: the change notice marks the project, and Save
 * writes it into the `.reel`. Works for a Missing clip too — no file is read.
 */
export function setMediaDescription(id: string, text: string, s: ProjectSession = requireSession()): void {
  const entry = s.library.getEntry(id)
  if (!entry) throw new Error(`No media "${id}" in this project.`)
  const description = normalizeDescription(text)
  if ((entry.record.description ?? '') === description) return
  const { description: _old, ...rest } = entry.record
  s.library.putEntry(description ? { ...rest, description } : rest, entry.path, s.root)
}

/**
 * Probe a file and add it to the library as a new item `id` pointing at it,
 * building the instant artifacts (thumb, display PNG).
 */
async function register(
  s: ProjectSession,
  id: string,
  path: string,
  fileName: string,
  fingerprint: MediaRecord['fingerprint'],
  generated: boolean
): Promise<MediaAsset> {
  const probe = await probeFile(path)
  // Level-probe stereo sources for a dead channel so the proxy + export can
  // mono-fold "mono mic on one side" footage (best-effort; null on any failure).
  if (probe.audio?.channels === 2) {
    probe.audio.monoFoldChannel = await detectMonoFoldChannel(path)
  }
  const kind: MediaKind = kindOfFile(path, probe)
  const record: MediaRecord = {
    id,
    fileName,
    relativePath: toRelativePath(s.root, path),
    absolutePath: path,
    fingerprint,
    ...(generated ? { generated: true } : {}),
    importedAt: new Date().toISOString(),
    probe,
    kind
  }
  const asset = toAsset(s, s.library.putEntry(record, path, s.root))
  await makeThumb(s, asset)
  await makeImage(s, asset) // images: build the display PNG now (it is their "proxy")
  kickLoudness(s, loudnessSource(asset))
  asset.proxyReady = existsSync(playableProxyPath(s.root, asset))
  return asset
}

/**
 * Fingerprint + probe a source file, adding it to the open project's library
 * as a POINTER to where it is. Fast (no transcode, no copy). Importing content
 * the library already holds reuses that item — and repoints it here if its
 * original had gone missing.
 */
export async function importFile(
  srcPath: string,
  displayName?: string,
  s: ProjectSession = requireSession()
): Promise<MediaAsset> {
  const { library } = s
  const fp = await library.fingerprintOf(srcPath)
  const id = library.freeIdFor(fingerprintId(fp), fp)
  return s.importFlight(id, async () => {
    const existing = library.findByFingerprint(fp)
    if (existing) {
      const res = await library.resolveEntry(existing.record.id)
      if (res && !res.entry.path) library.putEntry(pointAt(s.root, res.entry.record, srcPath), srcPath, s.root)
      return hydrate(s, toAsset(s, library.getEntry(existing.record.id)!))
    }
    return register(s, id, srcPath, displayName ?? basename(srcPath), fp, false)
  })
}

/**
 * Adopt a file the app GENERATED (in tmp) as a library item: MOVED into the
 * project's `generated/` under a readable, unique name. Identical output
 * reuses the existing item, which gives re-rendering a cache for free.
 */
export async function importGenerated(
  tmpPath: string,
  displayName: string,
  s: ProjectSession = requireSession()
): Promise<MediaAsset> {
  const { library } = s
  const fp = await library.fingerprintOf(tmpPath)
  const id = library.freeIdFor(fingerprintId(fp), fp)
  return s.importFlight(id, async () => {
    const existing = library.findByFingerprint(fp)
    const found = existing ? await library.resolveEntry(existing.record.id) : null
    if (found?.entry.path) {
      await fsp.rm(tmpPath, { force: true })
      return hydrate(s, toAsset(s, found.entry))
    }
    const dir = generatedRoot(s.root)
    await fsp.mkdir(dir, { recursive: true })
    // The display name (e.g. "clip (no bg 0:03–0:05).webm") may not be a legal
    // file name; the library keeps showing it, the file gets a safe one.
    const dest = join(
      dir,
      uniqueFileName(safeFileName(displayName), (n) => existsSync(join(dir, n)))
    )
    await moveFile(tmpPath, dest)
    if (existing) {
      return hydrate(s, toAsset(s, library.putEntry(pointAt(s.root, existing.record, dest), dest, s.root)))
    }
    return register(s, id, dest, displayName, fp, true)
  })
}

/**
 * Generate the proxy if missing, reporting progress via the jobs channel.
 * Concurrent calls for one asset share a single build (import, re-import and
 * the renderer can all ask), and every caller's promise settles only once the
 * proxy is on disk in full — or the build failed.
 */
export function ensureProxy(id: string, s: ProjectSession = requireSession()): Promise<void> {
  return s.proxyFlight(cacheDir(s.root, id), () => buildProxy(s, id))
}

// `proxyFailed` (on the session, keyed by cache dir): the library load doesn't
// retry a failed build on every refetch. An explicit `ensureProxy` (import,
// re-import, the assistant) still tries again.

/** Start a missing proxy in the background — what makes cache/ disposable for
 *  proxies too, and what builds them for media that arrived without one
 *  (an encode interrupted by quitting, a converted project). Progress and the
 *  library refresh ride on the proxy job, as for an import. */
function kickProxy(s: ProjectSession, id: string): void {
  const key = cacheDir(s.root, id)
  if (s.proxyFailed.has(key)) return
  void s
    .proxyFlight(key, () => buildProxy(s, id))
    .catch((error) => {
      s.proxyFailed.add(key)
      log.error(`proxy generation failed for ${id}`, error)
    })
}

async function buildProxy(s: ProjectSession, id: string): Promise<void> {
  const r = s.root
  const asset = await readAsset(s, id)
  if (!asset) throw new Error(`unknown media ${id}`)
  if (existsSync(playableProxyPath(r, asset))) return
  if (asset.status !== 'ok') {
    throw new Error(unusableMessage([{ fileName: asset.fileName, status: asset.status! }]))
  }
  await fsp.mkdir(cacheDir(r, id), { recursive: true })

  // Images need no transcode — just the display PNG (built best-effort at import).
  if (isImageAsset(asset)) {
    await makeImage(s, asset)
    return
  }

  // Audio-only: small AAC proxy + a waveform for the music lane.
  if (isAudioAsset(asset)) {
    const job = createJob('proxy', `Audio · ${asset.fileName}`, id, { uses: [id] })
    try {
      await generateAudioProxy(asset.originalPath, audioProxyPath(r, id), asset.probe.audio?.monoFoldChannel ?? null)
      await makeWaveform(s, asset)
      finishJob(job.id)
    } catch (error) {
      failJob(job.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return
  }

  await makeThumb(s, asset) // ensure a thumbnail exists even if import-time gen failed
  const job = createJob('proxy', `Proxy · ${asset.fileName}`, id, { uses: [id] })
  try {
    // Alpha clips (background-removed) proxy to a VP9 WebM so preview keeps
    // transparency; everything else gets the small H.264 mp4.
    if (isAlphaVideo(asset)) {
      await generateAlphaProxy(asset.originalPath, alphaProxyPath(r, id), asset.probe, job.id)
    } else {
      await generateProxy(asset.originalPath, proxyPath(r, id), asset.probe, job.id)
    }
    await makeWaveform(s, asset) // for the audio lane if this clip's audio is extracted
    finishJob(job.id)
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Backfill derived artifacts (thumb/image/waveform), refresh proxyReady, and
 *  start a missing proxy and loudness series (both in the background). A
 *  missing original gets no new artifacts; whatever cache exists still shows. */
async function hydrate(s: ProjectSession, asset: MediaAsset): Promise<MediaAsset> {
  if (asset.status !== 'ok') return asset
  await makeThumb(s, asset)
  await makeImage(s, asset)
  await makeWaveform(s, asset)
  kickLoudness(s, loudnessSource(asset))
  asset.proxyReady = existsSync(playableProxyPath(s.root, asset))
  if (!asset.proxyReady) kickProxy(s, asset.id)
  return asset
}

/**
 * The library for the open project: the assets for the given ids (the
 * project's `mediaIds`), each original located now. Unknown ids are skipped.
 * Sorted newest-import first.
 */
export async function getProjectMedia(ids: string[], s: ProjectSession = requireSession()): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = []
  for (const id of ids) {
    const asset = await readAsset(s, id)
    if (asset) assets.push(await hydrate(s, asset))
  }
  return assets.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
}

/** A fresh tmp path for a generated output (removed by the startup tmp sweep
 *  if a job dies before adopting it). */
export const tmpOutput = (prefix: string, ext: string): string =>
  join(getSubdir('tmp'), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)

/**
 * Pull a source file's audio into the library as a standalone audio asset (no
 * timeline placement needed), saved in `generated/`. Re-extracting identical
 * audio reuses the existing item; the normal pipeline then builds the AAC
 * proxy + waveform in the background.
 * Throws if the source has no audio stream.
 */
export async function extractAudioToLibrary(
  srcPath: string,
  s: ProjectSession = requireSession()
): Promise<MediaAsset> {
  const probe = await probeFile(srcPath)
  if (!probe.audio) throw new Error('That file has no audio track to extract.')

  const { name } = parse(srcPath)
  const job = createJob('proxy', `Extract audio · ${name}`)
  try {
    const tmp = tmpOutput('extract', 'wav')
    await extractAudio(srcPath, tmp)
    const asset = await importGenerated(tmp, `${name} (audio).wav`, s)
    finishJob(job.id)
    // Kick the AAC proxy + waveform in the background (its own job), so the
    // library row flips to "ready to drag onto the music track" when done.
    if (!asset.proxyReady) {
      void ensureProxy(asset.id, s).catch((err) => log.error(`audio proxy generation failed for ${asset.id}`, err))
    }
    return asset
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * Render an audio effect's WET signal from an existing library asset and import
 * the result as a new asset — the "add sound effect" pipeline.
 *
 * The output is fingerprinted like every other generated asset, which gives
 * re-rendering its cache for free: the same source window through the same
 * settings produces identical bytes, so flipping a setting back and forth
 * reuses the file already on disk instead of re-encoding.
 *
 * The caller places the returned asset on the timeline as its own `AudioClip`
 * (`kind: 'fx'`, carrying the `AudioFx` provenance). @see shared/audioFx.ts
 */
export async function renderAudioFxToLibrary(
  settings: AudioFxSettings,
  sourceMediaId: string,
  inSec: number,
  outSec: number,
  s: ProjectSession = requireSession()
): Promise<MediaAsset> {
  const source = await requireUsable(sourceMediaId, s)
  if (!source.probe.audio) throw new Error('That clip has no audio to build an effect from.')
  if (!(outSec > inSec)) throw new Error('That clip’s in/out points do not span any audio.')

  const label = fxLabel(settings)
  const { name } = parse(source.fileName)
  const job = createJob('proxy', `${label} · ${name}`, undefined, { uses: [sourceMediaId] })
  try {
    const tmp = tmpOutput('fx', 'wav')
    await renderAudioFx(settings, source.originalPath, inSec, outSec, tmp)
    const asset = await importGenerated(tmp, `${name} (${label}).wav`, s)
    finishJob(job.id)
    // AAC proxy + waveform in the background, as for any imported audio — the
    // effect track needs both to be playable and to draw on the timeline.
    if (!asset.proxyReady) {
      void ensureProxy(asset.id, s).catch((err) => log.error(`effect proxy generation failed for ${asset.id}`, err))
    }
    return asset
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
