/**
 * First-frame thumbnail (thumb.jpg) for library tiles + preview poster. Mirrors
 * the proxy's color handling (HDR sources get the same tonemap) so the thumb
 * matches the eventual preview. buildThumbnailArgs is pure (unit-tested).
 */

import type { ProbeInfo } from '@shared/media'
import { alphaInputDecoder } from '@shared/media'
import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
import { hdrToSdrChain } from './proxy'

const THUMB_MAX_EDGE = 360

export function thumbDimensions(probe: ProbeInfo): { w: number; h: number } {
  const srcW = probe.video?.displayWidth || 1080
  const srcH = probe.video?.displayHeight || 1920
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(srcW, srcH))
  const even = (n: number): number => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { w: even(srcW), h: even(srcH) }
}

export function buildThumbnailArgs(input: string, output: string, probe: ProbeInfo): string[] {
  const { w, h } = thumbDimensions(probe)
  const chain: string[] = []
  if (probe.video?.isHdr) chain.push(hdrToSdrChain(probe.video))
  chain.push(`scale=${w}:${h}:flags=bicubic`)
  // Alpha WebM: force the libvpx decoder so the thumb shows the matted subject
  // (over black) instead of the model's full-frame foreground smear.
  const dec = alphaInputDecoder(probe.video)
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...(dec ? ['-c:v', dec] : []),
    '-ss',
    '0',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    chain.join(','),
    '-q:v',
    '4',
    output
  ]
}

export async function generateThumbnail(
  input: string,
  output: string,
  probe: ProbeInfo
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await runFfmpeg(ffmpeg, buildThumbnailArgs(input, output, probe), 0)
}
