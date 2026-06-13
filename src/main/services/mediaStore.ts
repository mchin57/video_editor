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
const assetJsonPath = (id: string): string => join(mediaDir(id), 'asset.json')

async function readAsset(id: string): Promise<MediaAsset | null> {
  try {
    return JSON.parse(await fsp.readFile(assetJsonPath(id), 'utf8')) as MediaAsset
  } catch {
    return null
  }
}

async function writeAsset(asset: MediaAsset): Promise<void> {
  await fsp.writeFile(assetJsonPath(asset.id), JSON.stringify(asset, null, 2))
}

/** Hash + probe a source file, registering it in the library. Fast (no transcode). */
export async function importFile(srcPath: string): Promise<MediaAsset> {
  const id = await hashFile(srcPath)
  await fsp.mkdir(mediaDir(id), { recursive: true })

  const existing = await readAsset(id)
  if (existing) {
    existing.proxyReady = existsSync(proxyPath(id))
    return existing
  }

  const probe = await probeFile(srcPath)
  const asset: MediaAsset = {
    id,
    fileName: basename(srcPath),
    originalPath: srcPath,
    importedAt: new Date().toISOString(),
    probe,
    proxyReady: existsSync(proxyPath(id)),
    transcribed: existsSync(join(mediaDir(id), 'transcript.json'))
  }
  await writeAsset(asset)
  return asset
}

/** Generate the proxy if missing, reporting progress via the jobs channel. */
export async function ensureProxy(id: string): Promise<void> {
  if (existsSync(proxyPath(id))) return
  const asset = await readAsset(id)
  if (!asset) throw new Error(`unknown media ${id}`)

  const job = createJob('proxy', `Proxy · ${asset.fileName}`, id)
  try {
    await generateProxy(asset.originalPath, proxyPath(id), asset.probe, job.id)
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
      asset.proxyReady = existsSync(proxyPath(id))
      assets.push(asset)
    }
  }
  return assets.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
}

export async function removeMedia(id: string): Promise<void> {
  await fsp.rm(mediaDir(id), { recursive: true, force: true })
}
