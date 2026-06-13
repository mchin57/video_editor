import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * On-disk layout for media, projects, exports and scratch. Created lazily.
 * Default root: <Documents>\VideoEditor (overridable via VIDEO_EDITOR_DATA).
 */
function resolveDataDir(): string {
  const override = process.env.VIDEO_EDITOR_DATA
  if (override) return override
  // app.getPath('documents') is unavailable until app is ready; callers use
  // getDataDir() after ready.
  return join(app.getPath('documents'), 'VideoEditor')
}

let cachedRoot: string | null = null

export function getDataDir(): string {
  if (!cachedRoot) cachedRoot = resolveDataDir()
  return cachedRoot
}

export function getSubdir(name: 'media' | 'projects' | 'exports' | 'tmp' | 'bin'): string {
  const p = join(getDataDir(), name)
  mkdirSync(p, { recursive: true })
  return p
}

export const FFMPEG_PATH_OVERRIDE = process.env.FFMPEG_PATH ?? null
export const FFPROBE_PATH_OVERRIDE = process.env.FFPROBE_PATH ?? null
