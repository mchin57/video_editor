/**
 * Proxy transcode: iPhone HEVC (and anything else) → a small H.264 mp4 the
 * renderer's <video> can scrub smoothly. HDR sources get the same tonemap the
 * export will use, so preview color matches output. VFR sources are forced to
 * CFR so the timeline scrubs predictably.
 *
 * buildProxyArgs is pure (unit-tested); generateProxy runs ffmpeg with progress.
 */

import { spawn } from 'node:child_process'
import type { ProbeInfo, VideoStreamInfo } from '@shared/media'
import { getBinaries } from './ffmpeg'
import { setProgress } from './jobs'

const PROXY_MAX_EDGE = 1280

/** Even-rounded proxy dims; longest edge ≤ PROXY_MAX_EDGE, never upscales. */
export function proxyDimensions(probe: ProbeInfo): { w: number; h: number } {
  const srcW = probe.video?.displayWidth || 1080
  const srcH = probe.video?.displayHeight || 1920
  const scale = Math.min(1, PROXY_MAX_EDGE / Math.max(srcW, srcH))
  const even = (n: number): number => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { w: even(srcW), h: even(srcH) }
}

function targetFps(probe: ProbeInfo): number {
  const fps = Math.round(probe.video?.avgFps || 30)
  return Math.min(60, Math.max(24, fps || 30))
}

/**
 * PQ/HLG → SDR bt709. The input characteristics are set explicitly from the
 * probe (iPhone HDR is often only partially tagged; without tin/min/pin zscale
 * errors with "no path between colorspaces"). Kept identical to the planned
 * export tonemap so preview color matches output.
 */
export function hdrToSdrChain(v: VideoStreamInfo): string {
  const tin = v.colorTransfer ?? 'smpte2084'
  const pin = v.colorPrimaries ?? 'bt2020'
  const min = v.colorSpace ?? 'bt2020nc'
  const npl = tin === 'smpte2084' || tin === 'smptest2084' ? ':npl=100' : ''
  return [
    `zscale=tin=${tin}:min=${min}:pin=${pin}:t=linear${npl}`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p'
  ].join(',')
}

export function buildProxyArgs(input: string, output: string, probe: ProbeInfo): string[] {
  const { w, h } = proxyDimensions(probe)
  const chain: string[] = []
  if (probe.video?.isHdr) chain.push(hdrToSdrChain(probe.video))
  chain.push(`scale=${w}:${h}:flags=bicubic`, 'format=yuv420p')

  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-vf',
    chain.join(',')
  ]

  if (probe.video?.isVfr) {
    args.push('-fps_mode', 'cfr', '-r', String(targetFps(probe)))
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')

  if (probe.audio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k')
  } else {
    args.push('-an')
  }

  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output)
  return args
}

/** Run the proxy transcode, reporting progress (0..1) to the given job. */
export async function generateProxy(
  input: string,
  output: string,
  probe: ProbeInfo,
  jobId: string
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  const args = buildProxyArgs(input, output, probe)
  const durationSec = probe.durationSec || 0

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let tail = ''

    child.stdout.on('data', (buf: Buffer) => {
      const matches = [...buf.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)]
      const last = matches.at(-1)
      if (last && durationSec > 0) {
        const sec = Number(last[1]) / 1e6 // ffmpeg emits microseconds for both keys
        setProgress(jobId, Math.min(0.99, sec / durationSec))
      }
    })
    child.stderr.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString()).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg proxy exited ${code}: ${tail.slice(-500)}`))
    })
  })
}
