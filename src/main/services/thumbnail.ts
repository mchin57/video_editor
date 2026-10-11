/**
 * First-frame thumbnail (thumb.jpg) for library tiles + preview poster. Mirrors
 * the proxy's color handling (HDR sources get the same tonemap) so the thumb
 * matches the eventual preview. buildThumbnailArgs is pure (unit-tested).
 */

import type { ProbeInfo } from '@shared/media'
import { alphaInputDecoder } from '@shared/media'
import { writeAtomically } from './atomicWrite'
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

/**
 * `still` = the input is a single-frame image. It gets no `-ss`: on a JPEG
 * (image2/mjpeg) ffmpeg 8.1 drops the only frame after an input seek, even to
 * 0, and exits 0 having written nothing — so every JPEG's thumb used to fail.
 * PNGs survive the seek; without it every still works (verified,
 * docs/FFMPEG-NOTES.md "Stills: no input seek").
 */
export function buildThumbnailArgs(input: string, output: string, probe: ProbeInfo, still = false): string[] {
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
    ...(still ? [] : ['-ss', '0']),
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
  probe: ProbeInfo,
  still = false
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await writeAtomically(output, (part) => runFfmpeg(ffmpeg, buildThumbnailArgs(input, part, probe, still), 0))
}
