import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { FfmpegCapabilities } from '@shared/ffmpeg'
import { EMPTY_CAPABILITIES } from '@shared/ffmpeg'
import { FFMPEG_PATH_OVERRIDE, FFPROBE_PATH_OVERRIDE, getBundledBinDir } from '../config'

const execFileAsync = promisify(execFile)

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''

// Homebrew (Apple Silicon + Intel) and MacPorts bin dirs. A .app launched from
// Finder does not inherit the shell PATH, so these are probed explicitly on macOS.
const MAC_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']

/** Find <exe> inside the winget Packages tree: Gyan.FFmpeg... > ffmpeg-... > bin > exe. */
function findInWingetPackages(exe: string): string | null {
  if (!LOCALAPPDATA) return null
  const pkgRoot = join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(pkgRoot)) return null
  let dirs: string[]
  try {
    dirs = readdirSync(pkgRoot).filter((d) => d.toLowerCase().startsWith('gyan.ffmpeg'))
  } catch {
    return null
  }
  for (const d of dirs) {
    const base = join(pkgRoot, d)
    // ffmpeg-<ver>-full_build\bin\<exe>
    let inner: string[]
    try {
      inner = readdirSync(base).filter((x) => x.toLowerCase().startsWith('ffmpeg-'))
    } catch {
      continue
    }
    for (const i of inner) {
      const candidate = join(base, i, 'bin', exe)
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  return null
}

/** Ordered discovery candidates for a binary, most-explicit first. */
function candidates(name: 'ffmpeg' | 'ffprobe', override: string | null): string[] {
  const list: string[] = []
  if (override) list.push(override)
  // Binaries bundled into the installer (resources/bin/ffmpeg) — used on clean
  // machines that have no system ffmpeg. Absent in dev unless staged.
  const bundled = getBundledBinDir()
  if (bundled) list.push(join(bundled, 'ffmpeg', process.platform === 'win32' ? `${name}.exe` : name))
  // Bare name resolves via PATH when the app is launched from a shell that has it.
  list.push(name)
  if (process.platform === 'win32') {
    const exe = `${name}.exe`
    if (LOCALAPPDATA) list.push(join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe))
    const pkg = findInWingetPackages(exe)
    if (pkg) list.push(pkg)
  } else if (process.platform === 'darwin') {
    for (const dir of MAC_BIN_DIRS) list.push(join(dir, name))
  }
  return list
}

async function firstRunnable(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await execFileAsync(p, ['-hide_banner', '-version'], { windowsHide: true })
      return p
    } catch {
      // try next
    }
  }
  return null
}

let cached: FfmpegCapabilities | null = null

export async function getCapabilities(force = false): Promise<FfmpegCapabilities> {
  if (cached && !force) return cached

  const ffmpegPath = await firstRunnable(candidates('ffmpeg', FFMPEG_PATH_OVERRIDE))
  if (!ffmpegPath) {
    cached = { ...EMPTY_CAPABILITIES }
    return cached
  }
  const ffprobePath = await firstRunnable(candidates('ffprobe', FFPROBE_PATH_OVERRIDE))

  const [versionOut, encodersOut, filtersOut] = await Promise.all([
    execFileAsync(ffmpegPath, ['-hide_banner', '-version'], { windowsHide: true }).then((r) => r.stdout),
    execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true }).then((r) => r.stdout),
    execFileAsync(ffmpegPath, ['-hide_banner', '-filters'], { windowsHide: true }).then((r) => r.stdout)
  ])

  const has = (text: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(text)

  const encoders = {
    h264_nvenc: has(encodersOut, 'h264_nvenc'),
    hevc_nvenc: has(encodersOut, 'hevc_nvenc'),
    libx264: has(encodersOut, 'libx264'),
    libx265: has(encodersOut, 'libx265'),
    aac: has(encodersOut, 'aac')
  }
  const filters = {
    ass: has(filtersOut, 'ass'),
    subtitles: has(filtersOut, 'subtitles'),
    zscale: has(filtersOut, 'zscale'),
    tonemap: has(filtersOut, 'tonemap'),
    sidechaincompress: has(filtersOut, 'sidechaincompress'),
    showwavespic: has(filtersOut, 'showwavespic')
  }

  const problems: string[] = []
  if (!encoders.libx264 && !encoders.h264_nvenc) problems.push('No H.264 encoder (need libx264 or h264_nvenc)')
  if (!filters.ass) problems.push('Missing "ass" filter (needed to burn captions/overlays)')
  if (!filters.zscale) problems.push('Missing "zscale" filter (needed for HDR tone-mapping)')
  if (!encoders.aac) problems.push('Missing AAC encoder')

  const versionLine = versionOut.split('\n')[0]?.trim() ?? null

  cached = {
    found: true,
    ffmpegPath,
    ffprobePath,
    version: versionLine,
    encoders,
    filters,
    nvencAvailable: encoders.h264_nvenc,
    usable: problems.length === 0,
    problems
  }
  return cached
}

/** Resolve just the ffmpeg/ffprobe paths (for other services), discovering once. */
export async function getBinaries(): Promise<{ ffmpeg: string; ffprobe: string | null }> {
  const caps = await getCapabilities()
  if (!caps.found || !caps.ffmpegPath) throw new Error('ffmpeg not found')
  return { ffmpeg: caps.ffmpegPath, ffprobe: caps.ffprobePath }
}
