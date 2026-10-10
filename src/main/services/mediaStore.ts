/**
 * The open project's media library. Each project folder OWNS its media
 * (docs/PROJECT-FOLDERS.md): `media/<id>/` holds the original — a hardlink to
 * the imported source (no extra disk), a copy when linking fails, or a file
 * the app generated — plus its record `asset.json`; `cache/<id>/` holds the
 * derived files (proxy, thumb, waveform, display PNG), rebuilt on demand
 * whenever they are missing. Re-importing identical content reuses the record.
 *
 * Paths come from `projectLayout`; the folder from `projectRoot`. Every public
 * entry point captures the root ONCE, so a job outlives a project switch in the
 * folder it started in.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import { basename, join, parse } from 'node:path'
import type { MediaAsset, MediaKind, MediaStatus, MediaStorage } from '@shared/media'
import { assetKind, deriveKind, isAudioAsset, isImageAsset, kindFromExt } from '@shared/media'
import { getSubdir } from '../config'
import { probeFile } from './ffprobe'
import { generateProxy, generateAlphaProxy } from './proxy'
import { generateThumbnail } from './thumbnail'
import { generateDisplayImage } from './image'
import { detectMonoFoldChannel, extractAudio, generateAudioProxy, generateWaveform } from './audio'
import { createJob, failJob, finishJob } from './jobs'
import { replaceFile, singleFlight } from './atomicWrite'
import { linkOrCopy, moveFile } from './linkOrCopy'
import { getProjectRoot } from './projectRoot'
import { hashVerdict, statVerdict, unusableMessage } from './mediaHealth'
import {
  assetJsonPath,
  cacheDir,
  cachePath,
  mediaDir,
  originalName,
  transcriptPath
} from './projectLayout'
import type { AudioFxSettings } from '@shared/audioFx'
import { fxLabel } from '@shared/audioFx'
import { renderAudioFx } from './audioFx'

/** Content hash (first 12 hex of sha1) of a file — the media id. */
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
const proxyFlight = singleFlight<void>() // keyed by cache path of the proxy
const artifactFlight = singleFlight<void>() // keyed by output path
const importFlight = singleFlight<MediaAsset>() // keyed by media dir

/** Best-effort derived file: skipped if present, generated once however many
 *  callers race for it, and never throws (a missing thumb must not fail an import). */
async function makeArtifact(
  out: string,
  what: string,
  id: string,
  generate: (out: string) => Promise<void>
): Promise<void> {
  if (existsSync(out)) return
  await artifactFlight(out, async () => {
    try {
      await fsp.mkdir(join(out, '..'), { recursive: true })
      await generate(out)
    } catch (error) {
      console.error(`${what} failed for`, id, error)
    }
  })
}

/** Best-effort first-frame thumbnail; never fails the import if it errors. */
async function makeThumb(r: string, asset: MediaAsset): Promise<void> {
  if (!asset.probe.video) return
  await makeArtifact(thumbPath(r, asset.id), 'thumbnail', asset.id, (out) =>
    generateThumbnail(asset.originalPath, out, asset.probe)
  )
}

/** Best-effort waveform for any asset with audio (video included, for the
 *  audio lane when its audio is extracted onto the track). */
async function makeWaveform(r: string, asset: MediaAsset): Promise<void> {
  if (!asset.probe.audio) return
  await makeArtifact(waveformPath(r, asset.id), 'waveform', asset.id, (out) =>
    generateWaveform(asset.originalPath, out, asset.probe.durationSec)
  )
}

/** Best-effort display PNG (alpha-preserving) for an imported image. */
async function makeImage(r: string, asset: MediaAsset): Promise<void> {
  if (!isImageAsset(asset)) return
  await makeArtifact(imagePath(r, asset.id), 'display image', asset.id, (out) =>
    generateDisplayImage(asset.originalPath, out)
  )
}

/** On-disk record: the runtime asset minus the resolved `originalPath`, plus the
 *  original's file name inside its media dir. */
type AssetRecord = Omit<MediaAsset, 'originalPath'> & { file: string }

async function readAsset(r: string, id: string): Promise<MediaAsset | null> {
  try {
    const rec = JSON.parse(await fsp.readFile(assetJsonPath(r, id), 'utf8')) as AssetRecord
    const { file, ...rest } = rec
    const asset: MediaAsset = { ...rest, originalPath: join(mediaDir(r, id), file) }
    if (!asset.kind) asset.kind = assetKind(asset) // backfill records imported pre-kind
    return asset
  } catch {
    return null
  }
}

/** Public accessor for a single asset record of the open project. */
export const getAsset = (id: string): Promise<MediaAsset | null> => readAsset(getProjectRoot(), id)

/** Write a record — temp + rename, never in place: the rule for every file in a
 *  project folder, since a file there may be a hardlink (see linkOrCopy.ts). */
async function writeAsset(r: string, asset: MediaAsset): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { originalPath, status, ...rest } = asset
  const rec: AssetRecord = { ...rest, file: basename(originalPath) }
  await replaceFile(assetJsonPath(r, asset.id), JSON.stringify(rec, null, 2))
}

/** Record that an asset has a transcript (whisper calls this after caching it). */
export async function markTranscribed(id: string): Promise<void> {
  const r = getProjectRoot()
  const asset = await readAsset(r, id)
  if (!asset || asset.transcribed) return
  await writeAsset(r, { ...asset, transcribed: true })
}

/** Where an asset's transcript lives (project-owned: slow to rebuild). */
export const transcriptFile = (id: string): string => transcriptPath(getProjectRoot(), id)

/** Scratch dir for an asset's intermediate files (whisper's 16 kHz wav) — in
 *  the disposable cache, created on demand. */
export async function scratchDirFor(id: string): Promise<string> {
  const dir = cacheDir(getProjectRoot(), id)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** The audio proxy for an asset if it exists (export prefers it), else null. */
export function audioProxyIfReady(id: string): string | null {
  const p = audioProxyPath(getProjectRoot(), id)
  return existsSync(p) ? p : null
}

/** Absolute path to an image asset's display PNG, rebuilt first if the cache
 *  lost it (used by preview + export). */
export async function ensureImagePath(id: string): Promise<string> {
  const r = getProjectRoot()
  const asset = await readAsset(r, id)
  if (asset) await makeImage(r, asset)
  return imagePath(r, id)
}

/** Stat the original we hold — the change-detection key. */
async function statOf(path: string): Promise<{ size: number; mtimeMs: number }> {
  const s = await fsp.stat(path)
  return { size: s.size, mtimeMs: s.mtimeMs }
}

// --- Health: is the original still the file we imported? ---------------------

/** Hash per (path, size, mtime): a changed file is re-hashed once, not on every
 *  library refetch. */
const hashMemo = new Map<string, string>()
async function hashOnce(path: string, stamp: { size: number; mtimeMs: number }): Promise<string> {
  const key = `${path}|${stamp.size}|${stamp.mtimeMs}`
  let hash = hashMemo.get(key)
  if (!hash) {
    hash = await hashFile(path)
    hashMemo.set(key, hash)
  }
  return hash
}

/**
 * Check an asset's original against its record (docs/PROJECT-FOLDERS.md
 * "Changed-file detection"). A stat that matches costs nothing; a mismatch is
 * re-hashed: identical bytes just get re-stamped (silently), different bytes
 * are `changed`. Sets and returns `asset.status`.
 */
async function checkOriginal(r: string, asset: MediaAsset): Promise<MediaStatus> {
  const now = await statOf(asset.originalPath).catch(() => null)
  const first = statVerdict(asset, now)
  if (first !== 'rehash') return (asset.status = first)
  const verdict = hashVerdict(asset.hash ?? asset.id, await hashOnce(asset.originalPath, now!))
  if (verdict === 'changed') return (asset.status = 'changed')
  Object.assign(asset, now, { hash: asset.hash ?? asset.id })
  await writeAsset(r, asset).catch(() => {})
  return (asset.status = 'ok')
}

/** The asset, if its original is usable; else a clear error (jobs call this
 *  instead of letting ffmpeg fail on a missing or swapped file). */
export async function requireUsable(id: string): Promise<MediaAsset> {
  const r = getProjectRoot()
  const asset = await readAsset(r, id)
  if (!asset) throw new Error('That media is no longer in the library.')
  if ((await checkOriginal(r, asset)) !== 'ok') {
    throw new Error(unusableMessage([{ fileName: asset.fileName, status: asset.status! }]))
  }
  return asset
}

/** Throw (naming every file) unless all these assets are usable: export's gate. */
export async function assertMediaUsable(ids: string[]): Promise<void> {
  const r = getProjectRoot()
  const items: { fileName: string; status: MediaStatus }[] = []
  for (const id of new Set(ids)) {
    const asset = await readAsset(r, id)
    if (!asset) continue // the exporter already skips unknown media
    items.push({ fileName: asset.fileName, status: await checkOriginal(r, asset) })
  }
  if (items.some((i) => i.status !== 'ok')) throw new Error(unusableMessage(items))
}

/**
 * "Use the new file": accept a changed original as the asset's content. The id
 * stays (every clip keeps pointing at it); hash, stamp and probe follow the new
 * bytes, and the cache is dropped so it rebuilds from them.
 */
export async function acceptChangedMedia(id: string): Promise<MediaAsset> {
  const r = getProjectRoot()
  const asset = await readAsset(r, id)
  if (!asset) throw new Error('That media is no longer in the library.')
  const stamp = await statOf(asset.originalPath)
  const hash = await hashFile(asset.originalPath)
  const probe = await probeFile(asset.originalPath)
  if (probe.audio?.channels === 2) probe.audio.monoFoldChannel = await detectMonoFoldChannel(asset.originalPath)
  await fsp.rm(cacheDir(r, id), { recursive: true, force: true })
  const next: MediaAsset = { ...asset, ...stamp, hash, probe, status: 'ok' }
  await writeAsset(r, next)
  return hydrate(r, next)
}

/**
 * "Relink": point a missing or changed asset at `srcPath`, which must hold the
 * asset's ORIGINAL bytes (same hash): the same footage found elsewhere, a
 * backup. The project's original name is replaced (unlinking it from a source
 * that was overwritten) by a fresh link/copy of `srcPath`.
 */
export async function relinkMedia(id: string, srcPath: string): Promise<MediaAsset> {
  const r = getProjectRoot()
  const asset = await readAsset(r, id)
  if (!asset) throw new Error('That media is no longer in the library.')
  if ((await hashFile(srcPath)) !== (asset.hash ?? asset.id)) {
    throw new Error(`That file isn't the same footage as "${asset.fileName}" (its content differs).`)
  }
  await placeAgain(r, asset, srcPath)
  return hydrate(r, asset)
}

/** The id of the asset holding `hash`, if any — the record named by it, else a
 *  scan (only accepted changes make the two differ; projects hold hundreds of
 *  assets at most). */
async function findByHash(r: string, hash: string): Promise<string | null> {
  const named = await readAsset(r, hash)
  if (named && (named.hash ?? named.id) === hash) return hash
  let ids: string[] = []
  try {
    ids = await fsp.readdir(join(r, 'media'))
  } catch {
    return null
  }
  for (const id of ids) {
    if (id === hash) continue
    const asset = await readAsset(r, id)
    if (asset?.hash === hash) return id
  }
  return null
}

/** A media id for new content `hash`: the hash itself, unless an asset whose
 *  changed file was accepted still holds that name — then a derived hex id. */
async function freeIdFor(r: string, hash: string): Promise<string> {
  let id = hash
  for (let n = 1; existsSync(assetJsonPath(r, id)); n++) {
    id = createHash('sha1').update(`${hash}:${n}`).digest('hex').slice(0, 12)
  }
  return id
}

/** Replace the project's original with a link/copy of `srcPath` and re-stamp. */
async function placeAgain(r: string, asset: MediaAsset, srcPath: string): Promise<void> {
  const tmp = `${asset.originalPath}.relink`
  await fsp.rm(tmp, { force: true })
  const storage = await linkOrCopy(srcPath, tmp)
  await fsp.rm(asset.originalPath, { force: true })
  await fsp.rename(tmp, asset.originalPath)
  Object.assign(asset, { storage, sourcePath: srcPath, ...(await statOf(asset.originalPath)) })
  await writeAsset(r, asset)
}

/**
 * Register the original now at `media/<id>/<file>` as a library asset: probe it,
 * build the instant artifacts (thumb, display PNG) and write the record.
 */
async function register(
  r: string,
  id: string,
  original: string,
  fileName: string,
  storage: MediaStorage,
  sourcePath: string | null
): Promise<MediaAsset> {
  const probe = await probeFile(original)
  // Level-probe stereo sources for a dead channel so the proxy + export can
  // mono-fold "mono mic on one side" footage (best-effort; null on any failure).
  if (probe.audio?.channels === 2) {
    probe.audio.monoFoldChannel = await detectMonoFoldChannel(original)
  }
  const kind: MediaKind = kindFromExt(original) ?? deriveKind(probe)
  const asset: MediaAsset = {
    id,
    hash: id,
    fileName,
    originalPath: original,
    sourcePath,
    storage,
    ...(await statOf(original)),
    importedAt: new Date().toISOString(),
    probe,
    proxyReady: false,
    transcribed: existsSync(transcriptPath(r, id)),
    kind
  }
  await makeThumb(r, asset)
  await makeImage(r, asset) // images: build the display PNG now (it is their "proxy")
  asset.proxyReady = existsSync(playableProxyPath(r, asset))
  await writeAsset(r, asset)
  return asset
}

/**
 * Hash + probe a source file, registering it in the open project's library.
 * Fast (no transcode): the original is HARDLINKED into `media/<id>/` (a copy
 * only when linking fails), so moving, renaming or deleting the source later
 * can't break the clip. Re-importing identical content reuses the record, and
 * relinks it if the project's own original went missing.
 */
export async function importFile(srcPath: string, displayName?: string): Promise<MediaAsset> {
  const r = getProjectRoot()
  const hash = await hashFile(srcPath)
  // Dedup by CONTENT: usually the record named by the hash, but an asset whose
  // changed file was accepted keeps its old id under a new hash.
  const id = (await findByHash(r, hash)) ?? (await freeIdFor(r, hash))
  return importFlight(mediaDir(r, id), async () => {
    await fsp.mkdir(mediaDir(r, id), { recursive: true })
    const existing = await readAsset(r, id)
    if (existing && (existing.hash ?? existing.id) === hash) {
      // Re-importing an asset's bytes from wherever the user found them now
      // repairs a missing or changed original.
      if ((await checkOriginal(r, existing)) !== 'ok') await placeAgain(r, existing, srcPath)
      return hydrate(r, existing)
    }

    const original = join(mediaDir(r, id), originalName(srcPath))
    // An original without a record is a crash between placing and registering:
    // reuse it (a copy is only ever placed whole) and read its placement back.
    const storage: MediaStorage = existsSync(original)
      ? (await fsp.stat(original)).nlink > 1 ? 'link' : 'copy'
      : await linkOrCopy(srcPath, original)
    const asset = await register(r, id, original, displayName ?? basename(srcPath), storage, srcPath)
    if (id !== hash) {
      asset.hash = hash
      await writeAsset(r, asset)
    }
    return asset
  })
}

/**
 * Adopt a file the app GENERATED (in tmp) as a library asset: content-addressed
 * like any import, MOVED into `media/<id>/` (it is ours — no link). Identical
 * output reuses the existing asset, which gives re-rendering a cache for free.
 */
export async function importGenerated(tmpPath: string, displayName: string): Promise<MediaAsset> {
  const r = getProjectRoot()
  const id = await hashFile(tmpPath)
  return importFlight(mediaDir(r, id), async () => {
    await fsp.mkdir(mediaDir(r, id), { recursive: true })
    const existing = await readAsset(r, id)
    if (existing && existsSync(existing.originalPath)) {
      await fsp.rm(tmpPath, { force: true })
      return hydrate(r, existing)
    }
    const original = existing?.originalPath ?? join(mediaDir(r, id), originalName(tmpPath))
    await fsp.rm(original, { force: true })
    await moveFile(tmpPath, original)
    if (existing) {
      Object.assign(existing, { storage: 'generated', sourcePath: null, ...(await statOf(original)) })
      await writeAsset(r, existing)
      return hydrate(r, existing)
    }
    return register(r, id, original, displayName, 'generated', null)
  })
}

/**
 * Generate the proxy if missing, reporting progress via the jobs channel.
 * Concurrent calls for one asset share a single build (import, re-import and
 * the renderer can all ask), and every caller's promise settles only once the
 * proxy is on disk in full — or the build failed.
 */
export function ensureProxy(id: string): Promise<void> {
  const r = getProjectRoot()
  return proxyFlight(cacheDir(r, id), () => buildProxy(r, id))
}

async function buildProxy(r: string, id: string): Promise<void> {
  const asset = await readAsset(r, id)
  if (!asset) throw new Error(`unknown media ${id}`)
  if (existsSync(playableProxyPath(r, asset))) return
  if ((await checkOriginal(r, asset)) !== 'ok') {
    throw new Error(unusableMessage([{ fileName: asset.fileName, status: asset.status! }]))
  }
  await fsp.mkdir(cacheDir(r, id), { recursive: true })

  // Images need no transcode — just the display PNG (built best-effort at import).
  if (isImageAsset(asset)) {
    await makeImage(r, asset)
    return
  }

  // Audio-only: small AAC proxy + a waveform for the music lane.
  if (isAudioAsset(asset)) {
    const job = createJob('proxy', `Audio · ${asset.fileName}`, id)
    try {
      await generateAudioProxy(asset.originalPath, audioProxyPath(r, id), asset.probe.audio?.monoFoldChannel ?? null)
      await makeWaveform(r, asset)
      finishJob(job.id)
    } catch (error) {
      failJob(job.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return
  }

  await makeThumb(r, asset) // ensure a thumbnail exists even if import-time gen failed
  const job = createJob('proxy', `Proxy · ${asset.fileName}`, id)
  try {
    // Alpha clips (background-removed) proxy to a VP9 WebM so preview keeps
    // transparency; everything else gets the small H.264 mp4.
    if (isAlphaVideo(asset)) {
      await generateAlphaProxy(asset.originalPath, alphaProxyPath(r, id), asset.probe, job.id)
    } else {
      await generateProxy(asset.originalPath, proxyPath(r, id), asset.probe, job.id)
    }
    await makeWaveform(r, asset) // for the audio lane if this clip's audio is extracted
    finishJob(job.id)
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Backfill derived artifacts (thumb/image/waveform) and refresh proxyReady.
 *  `proxyReady` is never trusted from the record: cache/ may have been deleted. */
async function hydrate(r: string, asset: MediaAsset): Promise<MediaAsset> {
  // Unusable originals get no new artifacts (they would describe the wrong
  // bytes, or fail); whatever cache exists still shows.
  if ((await checkOriginal(r, asset)) !== 'ok') {
    asset.proxyReady = existsSync(playableProxyPath(r, asset))
    asset.transcribed = existsSync(transcriptPath(r, asset.id))
    return asset
  }
  await makeThumb(r, asset)
  await makeImage(r, asset)
  await makeWaveform(r, asset)
  asset.proxyReady = existsSync(playableProxyPath(r, asset))
  asset.transcribed = existsSync(transcriptPath(r, asset.id))
  return asset
}

/**
 * The library for the open project: the asset records for the given ids (the
 * project's `mediaIds`). Unknown ids are skipped. Sorted newest-import first.
 */
export async function getProjectMedia(ids: string[]): Promise<MediaAsset[]> {
  const r = getProjectRoot()
  const assets: MediaAsset[] = []
  for (const id of ids) {
    const asset = await readAsset(r, id)
    if (asset) assets.push(await hydrate(r, asset))
  }
  return assets.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
}

/** A fresh tmp path for a generated output (removed by the startup tmp sweep
 *  if a job dies before adopting it). */
export const tmpOutput = (prefix: string, ext: string): string =>
  join(getSubdir('tmp'), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)

/**
 * Pull a source file's audio into the library as a standalone audio asset (no
 * timeline placement needed). The extracted WAV is content-addressed, so
 * re-extracting identical audio reuses the existing record; the normal
 * pipeline then builds the AAC proxy + waveform in the background.
 * Throws if the source has no audio stream.
 */
export async function extractAudioToLibrary(srcPath: string): Promise<MediaAsset> {
  const probe = await probeFile(srcPath)
  if (!probe.audio) throw new Error('That file has no audio track to extract.')

  const { name } = parse(srcPath)
  const job = createJob('proxy', `Extract audio · ${name}`)
  try {
    const tmp = tmpOutput('extract', 'wav')
    await extractAudio(srcPath, tmp)
    const asset = await importGenerated(tmp, `${name} (audio).wav`)
    finishJob(job.id)
    // Kick the AAC proxy + waveform in the background (its own job), so the
    // library row flips to "ready to drag onto the music track" when done.
    if (!asset.proxyReady) {
      void ensureProxy(asset.id).catch((err) => console.error('audio proxy generation failed', err))
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
 * The output is content-addressed like every other generated asset, which gives
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
  outSec: number
): Promise<MediaAsset> {
  const source = await requireUsable(sourceMediaId)
  if (!source.probe.audio) throw new Error('That clip has no audio to build an effect from.')
  if (!(outSec > inSec)) throw new Error('That clip’s in/out points do not span any audio.')

  const label = fxLabel(settings)
  const { name } = parse(source.fileName)
  const job = createJob('proxy', `${label} · ${name}`)
  try {
    const tmp = tmpOutput('fx', 'wav')
    await renderAudioFx(settings, source.originalPath, inSec, outSec, tmp)
    const asset = await importGenerated(tmp, `${name} (${label}).wav`)
    finishJob(job.id)
    // AAC proxy + waveform in the background, as for any imported audio — the
    // effect track needs both to be playable and to draw on the timeline.
    if (!asset.proxyReady) {
      void ensureProxy(asset.id).catch((err) => console.error('audio fx proxy generation failed', err))
    }
    return asset
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
