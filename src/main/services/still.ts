/**
 * Capture a single still frame from a source video at an exact source-time, with
 * the same HDR tonemap / crop / color chain the preview applies, so a still
 * matches what's on screen. buildStillArgs is pure (unit-tested); generateStill
 * runs ffmpeg. Output format follows the file extension (.png keeps alpha-free
 * full quality; .jpg for a smaller copy).
 */

import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'

export function buildStillArgs(
  input: string,
  output: string,
  sourceSec: number,
  vfChain: string[] = [],
  /** Force this input decoder (`-c:v` before `-i`) — needed for VP8/VP9 alpha
   *  (see `alphaInputDecoder`, shared/media). */
  inputDecoder: string | null = null
): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...(inputDecoder ? ['-c:v', inputDecoder] : []),
    '-ss',
    Math.max(0, sourceSec).toFixed(3),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-frames:v',
    '1'
  ]
  if (vfChain.length) args.push('-vf', vfChain.join(','))
  // JPG benefits from an explicit quality; PNG ignores -q:v, so only add for jpg.
  if (/\.jpe?g$/i.test(output)) args.push('-q:v', '2')
  args.push(output)
  return args
}

export async function generateStill(
  input: string,
  output: string,
  sourceSec: number,
  vfChain: string[] = [],
  inputDecoder: string | null = null
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await runFfmpeg(ffmpeg, buildStillArgs(input, output, sourceSec, vfChain, inputDecoder), 0)
}
