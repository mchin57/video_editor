/**
 * Proxy transcode: iPhone HEVC (and anything else) → a small H.264 mp4 the
 * renderer's <video> can scrub smoothly. HDR sources get the same tonemap the
 * export will use, so preview color matches output. VFR sources are forced to
 * CFR so the timeline scrubs predictably.
 *
 * buildProxyArgs is pure (unit-tested); generateProxy runs ffmpeg with progress.
 */

import type { ProbeInfo, VideoStreamInfo } from '@shared/media'
import { alphaInputDecoder } from '@shared/media'
import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
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

/**
 * Alpha-preserving proxy for a background-removed clip: a downscaled VP9 WebM in
 * `yuva420p` so the renderer's <video> keeps transparency (H.264/mp4 can't). No
 * audio (these clips are silent). Chromium plays VP8/VP9-alpha WebM with a
 * transparent background, so the subject composites over lower layers in preview.
 */
export function buildAlphaProxyArgs(input: string, output: string, probe: ProbeInfo): string[] {
  const { w, h } = proxyDimensions(probe)
  // VP8/VP9 alpha only survives decoding under the libvpx decoders (the native
  // ones silently drop the side-band), so force the input decoder when needed.
  const dec = alphaInputDecoder(probe.video)
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...(dec ? ['-c:v', dec] : []),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-vf',
    `scale=${w}:${h}:flags=bicubic`,
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-b:v',
    '0',
    '-crf',
    '32',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-row-mt',
    '1',
    '-an',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ]
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
  await runFfmpeg(ffmpeg, buildProxyArgs(input, output, probe), probe.durationSec || 0, (p) =>
    setProgress(jobId, p)
  )
}

/** Run the alpha-preserving (VP9 WebM) proxy transcode for a background-removed clip. */
export async function generateAlphaProxy(
  input: string,
  output: string,
  probe: ProbeInfo,
  jobId: string
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await runFfmpeg(ffmpeg, buildAlphaProxyArgs(input, output, probe), probe.durationSec || 0, (p) =>
    setProgress(jobId, p)
  )
}
