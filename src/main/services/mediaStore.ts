/**
 * Content-hashed media library. Originals stay where they are (referenced by
 * path); each asset gets a folder <data>/media/<hash> holding asset.json, the
 * generated proxy.mp4, and later transcript.json. Re-importing identical content
 * reuses the existing record.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { MediaAsset } from '@shared/media'
import { getSubdir } from '../config'
import { probeFile } from './ffprobe'
import { generateProxy } from './proxy'
import { generateThumbnail } from './thumbnail'
import { generateAudioProxy, generateWaveform } from './audio'
import { createJob, failJob, finishJob } from './jobs'

function hashFile(path: string): Promise<string> {
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
const audioProxyPath = (id: string): string => join(mediaDir(id), 'audio.m4a')
const waveformPath = (id: string): string => join(mediaDir(id), 'waveform.png')
const thumbPath = (id: string): string => join(mediaDir(id), 'thumb.jpg')
const assetJsonPath = (id: string): string => join(mediaDir(id), 'asset.json')

/** Audio-only asset: has audio but no video stream. */
export const isAudioAsset = (a: MediaAsset): boolean => !a.probe.video && !!a.probe.audio
/** The playable proxy path for an asset (audio bed vs video proxy). */
const playableProxyPath = (a: MediaAsset): string =>
  isAudioAsset(a) ? audioProxyPath(a.id) : proxyPath(a.id)

/** Best-effort first-frame thumbnail; never fails the import if it errors. */
async function makeThumb(asset: MediaAsset): Promise<void> {
  if (!asset.probe.video || existsSync(thumbPath(asset.id))) return
  try {
    await generateThumbnail(asset.originalPath, thumbPath(asset.id), asset.probe)
  } catch (error) {
    console.error('thumbnail failed for', asset.id, error)
  }
}

/** Best-effort waveform for any asset with audio (video included, for the
 *  audio lane when its audio is extracted onto the track). */
async function makeWaveform(asset: MediaAsset): Promise<void> {
  if (!asset.probe.audio || existsSync(waveformPath(asset.id))) return
  try {
    await generateWaveform(asset.originalPath, waveformPath(asset.id))
  } catch (error) {
    console.error('waveform failed for', asset.id, error)
  }
}

async function readAsset(id: string): Promise<MediaAsset | null> {
  try {
    return JSON.parse(await fsp.readFile(assetJsonPath(id), 'utf8')) as MediaAsset
  } catch {
    return null
  }
}

/** Public accessor for a single asset record (used by the exporter). */
export const getAsset = (id: string): Promise<MediaAsset | null> => readAsset(id)

async function writeAsset(asset: MediaAsset): Promise<void> {
  await fsp.writeFile(assetJsonPath(asset.id), JSON.stringify(asset, null, 2))
}

/** Hash + probe a source file, registering it in the library. Fast (no transcode). */
export async function importFile(srcPath: string): Promise<MediaAsset> {
  const id = await hashFile(srcPath)
  await fsp.mkdir(mediaDir(id), { recursive: true })

  const existing = await readAsset(id)
  if (existing) {
    existing.proxyReady = existsSync(playableProxyPath(existing))
    await makeThumb(existing) // backfill for assets imported before thumbnails
    await makeWaveform(existing) // backfill waveform (e.g. video whose audio is extracted)
    return existing
  }

  const probe = await probeFile(srcPath)
  const asset: MediaAsset = {
    id,
    fileName: basename(srcPath),
    originalPath: srcPath,
    importedAt: new Date().toISOString(),
    probe,
    proxyReady: false,
    transcribed: existsSync(join(mediaDir(id), 'transcript.json'))
  }
  asset.proxyReady = existsSync(playableProxyPath(asset))
  await writeAsset(asset)
  await makeThumb(asset)
  return asset
}

/** Generate the proxy if missing, reporting progress via the jobs channel. */
export async function ensureProxy(id: string): Promise<void> {
  const asset = await readAsset(id)
  if (!asset) throw new Error(`unknown media ${id}`)
  if (existsSync(playableProxyPath(asset))) return

  // Audio-only: small AAC proxy + a waveform for the music lane.
  if (isAudioAsset(asset)) {
    const job = createJob('proxy', `Audio · ${asset.fileName}`, id)
    try {
      await generateAudioProxy(asset.originalPath, audioProxyPath(id))
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
    await generateProxy(asset.originalPath, proxyPath(id), asset.probe, job.id)
    await makeWaveform(asset) // for the audio lane if this clip's audio is extracted
    asset.proxyReady = true
    await writeAsset(asset)
    finishJob(job.id)
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

export async function listLibrary(): Promise<MediaAsset[]> {
  const root = getSubdir('media')
  let ids: string[]
  try {
    ids = await fsp.readdir(root)
  } catch {
    return []
  }
  const assets: MediaAsset[] = []
  for (const id of ids) {
    const asset = await readAsset(id)
    if (asset) {
      asset.proxyReady = existsSync(playableProxyPath(asset))
      await makeThumb(asset) // backfill thumbnails for assets imported pre-feature
      await makeWaveform(asset) // backfill waveforms (incl. video assets)
      assets.push(asset)
    }
  }
  return assets.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
}

export async function removeMedia(id: string): Promise<void> {
  await fsp.rm(mediaDir(id), { recursive: true, force: true })
}
