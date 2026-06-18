/**
 * Display copy for imported images: a PNG with alpha preserved, capped at 1920px
 * on the longest edge, written into the asset folder so it can be served over
 * reelmedia:// and fed to the export overlay filter. buildDisplayImageArgs is
 * pure (unit-tested). Originals (which may be HEIC, huge, or alpha-bearing) stay
 * referenced by path; this copy is what the renderer and exporter actually use.
 */

import { spawn } from 'node:child_process'
import { getBinaries } from './ffmpeg'

/** Longest-edge cap for the display PNG (the output canvas is 1080 wide). */
export const DISPLAY_IMAGE_MAX_EDGE = 1920

export function buildDisplayImageArgs(input: string, output: string): string[] {
  // Box = min(source, cap) on each axis; decrease fits within it without upscaling.
  const m = DISPLAY_IMAGE_MAX_EDGE
  const scale = `scale=w='min(iw,${m})':h='min(ih,${m})':force_original_aspect_ratio=decrease:flags=bicubic`
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    scale,
    '-c:v',
    'png',
    '-pix_fmt',
    'rgba',
    output
  ]
}

export async function generateDisplayImage(input: string, output: string): Promise<void> {
  const { ffmpeg } = await getBinaries()
  const args = buildDisplayImageArgs(input, output)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let tail = ''
    child.stderr.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString()).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg image exited ${code}: ${tail.slice(-300)}`))
    })
  })
}
