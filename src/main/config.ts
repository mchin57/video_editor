import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

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

export function getSubdir(
  name: 'media' | 'projects' | 'exports' | 'tmp' | 'bin' | 'extracted' | 'stills' | 'nobg'
): string {
  const p = join(getDataDir(), name)
  mkdirSync(p, { recursive: true })
  return p
}

export const FFMPEG_PATH_OVERRIDE = process.env.FFMPEG_PATH ?? null
export const FFPROBE_PATH_OVERRIDE = process.env.FFPROBE_PATH ?? null

/**
 * Directory holding the engine binaries bundled into the installer via
 * electron-builder `extraResources` (ffmpeg/ and whisper/ subdirs). In a
 * packaged app these live under <resources>/bin. In dev they're absent unless
 * `npm run collect-binaries` has staged them under resources/bin, in which case
 * we use that so the bundled engines can be exercised before packaging. Returns
 * null when no bundle is present, so discovery falls back to the system install.
 */
export function getBundledBinDir(): string | null {
  if (app.isPackaged) return join(process.resourcesPath, 'bin')
  for (const base of [app.getAppPath(), process.cwd()]) {
    const dir = join(base, 'resources', 'bin')
    if (existsSync(dir)) return dir
  }
  return null
}

/**
 * Directory holding the bundled text-overlay fonts (electron-builder
 * `extraResources` → <resources>/fonts; the committed `resources/fonts` in dev).
 * Passed to libass via `fontsdir` so the burned text uses the same faces the
 * preview shows. Returns null only if the folder is somehow absent.
 */
export function getBundledFontsDir(): string | null {
  if (app.isPackaged) return join(process.resourcesPath, 'fonts')
  for (const base of [app.getAppPath(), process.cwd()]) {
    const dir = join(base, 'resources', 'fonts')
    if (existsSync(dir)) return dir
  }
  return null
}

/**
 * Directory holding the bundled ML models (electron-builder `extraResources` →
 * <resources>/models; the committed/staged `resources/models` in dev). Currently
 * the RVM background-removal ONNX model. Returns null when absent, so discovery
 * can fall back to the user data dir (`<data>/bin/models`).
 */
export function getBundledModelsDir(): string | null {
  if (app.isPackaged) return join(process.resourcesPath, 'models')
  for (const base of [app.getAppPath(), process.cwd()]) {
    const dir = join(base, 'resources', 'models')
    if (existsSync(dir)) return dir
  }
  return null
}
