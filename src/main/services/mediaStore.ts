/**
 * Content-hashed media library. Originals stay where they are (referenced by
 * path); each asset gets a folder <data>/media/<hash> holding asset.json, the
 * generated proxy.mp4, and later transcript.json. Re-importing identical content
 * reuses the existing record.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import { basename, join, parse } from 'node:path'
import type { MediaAsset, MediaKind } from '@shared/media'
import { assetKind, deriveKind, isAudioAsset, isImageAsset, kindFromExt } from '@shared/media'
import { getSubdir } from '../config'
import { probeFile } from './ffprobe'
import { generateProxy, generateAlphaProxy } from './proxy'
import { generateThumbnail } from './thumbnail'
import { generateDisplayImage } from './image'
import { detectMonoFoldChannel, extractAudio, generateAudioProxy, generateWaveform } from './audio'
import { createJob, failJob, finishJob } from './jobs'
import { singleFlight } from './atomicWrite'
import type { AudioFxSettings } from '@shared/audioFx'
import { fxLabel } from '@shared/audioFx'
import { renderAudioFx } from './audioFx'

/** Content hash (first 12 hex of sha1) of a file — the media folder / id. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 12)))
  })
}

const mediaDir = (id: string): string => join(getSubdir('media'), id)
const proxyPath = (id: string): string => join(mediaDir(id), 'proxy.mp4')
/** Alpha-preserving proxy (VP9 WebM) for background-removed clips. */
const alphaProxyPath = (id: string): string => join(mediaDir(id), 'proxy.webm')
const audioProxyPath = (id: string): string => join(mediaDir(id), 'audio.m4a')
const imagePath = (id: string): string => join(mediaDir(id), 'image.png')
const waveformPath = (id: string): string => join(mediaDir(id), 'waveform.png')
const thumbPath = (id: string): string => join(mediaDir(id), 'thumb.jpg')
const assetJsonPath = (id: string): string => join(mediaDir(id), 'asset.json')

/** Absolute path to an image asset's display PNG (used by preview + export). */
export const imageAssetPath = (id: string): string => imagePath(id)

/** Whether a video asset carries an alpha channel (background-removed clip). */
const isAlphaVideo = (a: MediaAsset): boolean => !!a.probe.video?.hasAlpha

/** The "ready to use" artifact for an asset: image PNG, audio bed, or video proxy
 *  (a VP9 WebM for alpha clips so preview keeps transparency, else an H.264 mp4). */
const playableProxyPath = (a: MediaAsset): string =>
  isImageAsset(a)
    ? imagePath(a.id)
    : isAudioAsset(a)
      ? audioProxyPath(a.id)
      : isAlphaVideo(a)
        ? alphaProxyPath(a.id)
        : proxyPath(a.id)

/*
 * Every generated file here is gated on EXISTENCE (a present proxy.mp4 means
 * "ready"; a present thumb.jpg means "don't regenerate"), so two rules hold:
 * the generators write atomically (`writeAtomically` — the final name never
 * refers to a half-written file), and each file has at most one generator in
 * flight. The second matters because `hydrate` runs on EVERY library refetch
 * and would otherwise race the import's own generation onto the same partial.
 */
const proxyFlight = singleFlight<void>() // keyed by asset id
const artifactFlight = singleFlight<void>() // keyed by output path

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
      await generate(out)
    } catch (error) {
      console.error(`${what} failed for`, id, error)
    }
  })
}

/** Best-effort first-frame thumbnail; never fails the import if it errors. */
async function makeThumb(asset: MediaAsset): Promise<void> {
  if (!asset.probe.video) return
  await makeArtifact(thumbPath(asset.id), 'thumbnail', asset.id, (out) =>
    generateThumbnail(asset.originalPath, out, asset.probe)
  )
}

/** Best-effort waveform for any asset with audio (video included, for the
 *  audio lane when its audio is extracted onto the track). */
async function makeWaveform(asset: MediaAsset): Promise<void> {
  if (!asset.probe.audio) return
  await makeArtifact(waveformPath(asset.id), 'waveform', asset.id, (out) =>
    generateWaveform(asset.originalPath, out, asset.probe.durationSec)
  )
}

/** Best-effort display PNG (alpha-preserving) for an imported image. */
async function makeImage(asset: MediaAsset): Promise<void> {
  if (!isImageAsset(asset)) return
  await makeArtifact(imagePath(asset.id), 'display image', asset.id, (out) =>
    generateDisplayImage(asset.originalPath, out)
  )
}

async function readAsset(id: string): Promise<MediaAsset | null> {
  try {
    const asset = JSON.parse(await fsp.readFile(assetJsonPath(id), 'utf8')) as MediaAsset
    if (!asset.kind) asset.kind = assetKind(asset) // backfill records imported pre-kind
    return asset
  } catch {
    return null
  }
}

/** Public accessor for a single asset record (used by the exporter). */
export const getAsset = (id: string): Promise<MediaAsset | null> => readAsset(id)

async function writeAsset(asset: MediaAsset): Promise<void> {
  await fsp.writeFile(assetJsonPath(asset.id), JSON.stringify(asset, null, 2))
}

/**
 * Hash + probe a source file, registering it in the library. Fast (no transcode).
 * `displayName` overrides the shown file name (e.g. for extracted-audio assets
 * whose on-disk original is content-hashed rather than human-readable).
 */
export async function importFile(srcPath: string, displayName?: string): Promise<MediaAsset> {
  const id = await hashFile(srcPath)
  await fsp.mkdir(mediaDir(id), { recursive: true })

  const existing = await readAsset(id)
  if (existing) {
    await makeThumb(existing) // backfill for assets imported before thumbnails
    await makeImage(existing) // backfill display PNG for images
    await makeWaveform(existing) // backfill waveform (e.g. video whose audio is extracted)
    existing.proxyReady = existsSync(playableProxyPath(existing))
    return existing
  }

  const probe = await probeFile(srcPath)
  // Level-probe stereo sources for a dead channel so the proxy + export can
  // mono-fold "mono mic on one side" footage (best-effort; null on any failure).
  if (probe.audio?.channels === 2) {
    probe.audio.monoFoldChannel = await detectMonoFoldChannel(srcPath)
  }
  const kind: MediaKind = kindFromExt(srcPath) ?? deriveKind(probe)
  const asset: MediaAsset = {
    id,
    fileName: displayName ?? basename(srcPath),
    originalPath: srcPath,
    importedAt: new Date().toISOString(),
    probe,
    proxyReady: false,
    transcribed: existsSync(join(mediaDir(id), 'transcript.json')),
    kind
  }
  await makeThumb(asset)
  await makeImage(asset) // images: build the display PNG now (it is their "proxy")
  asset.proxyReady = existsSync(playableProxyPath(asset))
  await writeAsset(asset)
  return asset
}

/**
 * Generate the proxy if missing, reporting progress via the jobs channel.
 * Concurrent calls for one asset share a single build (import, re-import and
 * the renderer can all ask), and every caller's promise settles only once the
 * proxy is on disk in full — or the build failed.
 */
export function ensureProxy(id: string): Promise<void> {
  return proxyFlight(id, () => buildProxy(id))
}

async function buildProxy(id: string): Promise<void> {
  const asset = await readAsset(id)
  if (!asset) throw new Error(`unknown media ${id}`)
  if (existsSync(playableProxyPath(asset))) return

  // Images need no transcode — just the display PNG (built best-effort at import).
  if (isImageAsset(asset)) {
    await makeImage(asset)
    asset.proxyReady = existsSync(imagePath(id))
    await writeAsset(asset)
    return
  }

  // Audio-only: small AAC proxy + a waveform for the music lane.
  if (isAudioAsset(asset)) {
    const job = createJob('proxy', `Audio · ${asset.fileName}`, id)
    try {
      await generateAudioProxy(asset.originalPath, audioProxyPath(id), asset.probe.audio?.monoFoldChannel ?? null)
      await makeWaveform(asset)
      asset.proxyReady = true
      await writeAsset(asset)
      finishJob(job.id)
    } catch (error) {
      failJob(job.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return
  }

  await makeThumb(asset) // ensure a thumbnail exists even if import-time gen failed
  const job = createJob('proxy', `Proxy · ${asset.fileName}`, id)
  try {
    // Alpha clips (background-removed) proxy to a VP9 WebM so preview keeps
    // transparency; everything else gets the small H.264 mp4.
    if (isAlphaVideo(asset)) {
      await generateAlphaProxy(asset.originalPath, alphaProxyPath(id), asset.probe, job.id)
    } else {
      await generateProxy(asset.originalPath, proxyPath(id), asset.probe, job.id)
    }
    await makeWaveform(asset) // for the audio lane if this clip's audio is extracted
    asset.proxyReady = true
    await writeAsset(asset)
    finishJob(job.id)
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Backfill derived artifacts (thumb/image/waveform) and refresh proxyReady. */
async function hydrate(asset: MediaAsset): Promise<MediaAsset> {
  await makeThumb(asset) // backfill thumbnails for assets imported pre-feature
  await makeImage(asset) // backfill display PNGs for images
  await makeWaveform(asset) // backfill waveforms (incl. video assets)
  asset.proxyReady = existsSync(playableProxyPath(asset))
  return asset
}

/**
 * The library for one project: the asset records for the given ids (the
 * project's `mediaIds`). Unknown ids are skipped. Sorted newest-import first.
 * The on-disk store stays global — this only scopes *which* assets are shown.
 */
export async function getProjectMedia(ids: string[]): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = []
  for (const id of ids) {
    const asset = await readAsset(id)
    if (asset) assets.push(await hydrate(asset))
  }
  return assets.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
}

/**
 * Pull a source file's audio into the library as a standalone audio asset (no
 * timeline placement needed). The extracted WAV is content-addressed so its path
 * is stable and re-extracting identical audio reuses the existing record; the
 * normal import pipeline then builds the AAC proxy + waveform in the background.
 * Throws if the source has no audio stream.
 */
export async function extractAudioToLibrary(srcPath: string): Promise<MediaAsset> {
  const probe = await probeFile(srcPath)
  if (!probe.audio) throw new Error('That file has no audio track to extract.')

  const { name } = parse(srcPath)
  const job = createJob('proxy', `Extract audio · ${name}`)
  try {
    const tmp = join(getSubdir('tmp'), `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    await extractAudio(srcPath, tmp)
    const hash = await hashFile(tmp)
    const finalPath = join(getSubdir('extracted'), `${hash}.wav`)
    if (existsSync(finalPath)) await fsp.rm(tmp, { force: true })
    else await fsp.rename(tmp, finalPath)
    const asset = await importFile(finalPath, `${name} (audio).wav`)
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
  const source = await getAsset(sourceMediaId)
  if (!source) throw new Error('That clip’s media is no longer in the library.')
  if (!source.probe.audio) throw new Error('That clip has no audio to build an effect from.')
  if (!(outSec > inSec)) throw new Error('That clip’s in/out points do not span any audio.')

  const label = fxLabel(settings)
  const { name } = parse(source.fileName)
  const job = createJob('proxy', `${label} · ${name}`)
  try {
    const tmp = join(
      getSubdir('tmp'),
      `fx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
    )
    await renderAudioFx(settings, source.originalPath, inSec, outSec, tmp)
    const hash = await hashFile(tmp)
    const finalPath = join(getSubdir('audiofx'), `${hash}.wav`)
    if (existsSync(finalPath)) await fsp.rm(tmp, { force: true })
    else await fsp.rename(tmp, finalPath)
    const asset = await importFile(finalPath, `${name} (${label}).wav`)
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
