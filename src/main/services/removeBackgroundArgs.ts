/**
 * PURE helpers for the background-removal (subject matting) job. No onnx/node
 * deps so they can be unit-tested against synthetic frames. Three parts:
 *   - ffmpeg arg builders: decode ONE source window to upright raw RGB frames on
 *     stdout, and encode straight-alpha RGBA frames from stdin (plus the same
 *     window's audio from the source) to a VP9 (yuva420p) WebM.
 *   - frame plumbing: reassemble fixed-size frames from the decoder's pipe chunks.
 *   - RVM tensor conversions: an rgb24 frame → the model's CHW [0,1] `src` input,
 *     and the model's foreground+alpha outputs → a straight-alpha RGBA frame.
 * The spawn/session orchestration lives in removeBackground.ts.
 */

import { f3 } from './ffmpegFilters'

/** Reels are ≤1080×1920, so the matte is produced at source resolution capped to
 *  this longest edge (never upscaled) — matching the export's native size. */
export const MATTE_MAX_EDGE = 1920

/** The export renders at a fixed 30 fps (`exporterArgs`: `-r 30`), so a matte
 *  never needs more frames than that per second of PLAYED time. */
export const EXPORT_FPS = 30
/** Hard ceiling on the matte rate (slow-mo of a high-frame-rate source). */
export const MATTE_MAX_FPS = 60

/** A source window in the source's own time (seconds). */
export interface MatteWindow {
  startSec: number
  durationSec: number
}

/** Even-rounded matte dims: longest edge ≤ maxEdge, never upscaled. */
export function matteDims(
  displayWidth: number,
  displayHeight: number,
  maxEdge = MATTE_MAX_EDGE
): { w: number; h: number } {
  const srcW = displayWidth || 1080
  const srcH = displayHeight || 1920
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
  const even = (n: number): number => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { w: even(srcW), h: even(srcH) }
}

/**
 * Frame rate to matte at. Every matted frame costs a model run, and the export
 * samples 30 frames per second of played time — so at normal speed a 60 fps
 * iPhone clip only needs every other frame. A slowed-down clip plays source
 * time slower, so it needs `30 / speed` source frames per second to stay as
 * smooth as the original; never more than the source actually has, nor 60.
 */
export function matteFps(sourceFps: number, minSpeed = 1): number {
  const src = Math.round(sourceFps) || EXPORT_FPS
  const speed = Number.isFinite(minSpeed) && minSpeed > 0 ? minSpeed : 1
  const needed = Math.ceil(EXPORT_FPS / Math.min(1, speed))
  return Math.max(1, Math.min(src, needed, MATTE_MAX_FPS))
}

/**
 * RVM `downsample_ratio`: the model runs its recurrent guidance on a downsampled
 * copy; the authors recommend a downsampled long edge of ~256–512px. Aim for 512,
 * clamped to [0.25, 1] (1 = don't downsample, for already-small clips).
 */
export function downsampleRatioFor(w: number, h: number): number {
  const r = 512 / Math.max(w, h)
  return Math.min(1, Math.max(0.25, Math.round(r * 1000) / 1000))
}

/** Input-side seek to a window: `-ss`/`-t` BEFORE `-i`, so only the window is
 *  demuxed and decoded (and the output's t=0 is the window start). */
function windowArgs(window: MatteWindow | undefined): string[] {
  return window ? ['-ss', f3(window.startSec), '-t', f3(window.durationSec)] : []
}

/**
 * Decode (a window of) the source to upright (auto-rotated) raw RGB frames at
 * (w,h) and a fixed fps, streamed on stdout. `preFilter` folds in an HDR→SDR
 * tonemap for HDR sources so the model sees sane [0,1] colour (empty = none).
 *
 * The rate is set with the `fps` FILTER, not output `-r`: after an input `-ss`,
 * `-r 30` on a 60 fps source emits the first frames at the wrong cadence and
 * two extra frames, shifting the whole matte ~50 ms late against the source
 * (FFMPEG-NOTES "Matte decode"). `fps` runs first so the tonemap and scale
 * only ever see frames that are kept.
 */
export function buildMatteDecodeArgs(
  input: string,
  w: number,
  h: number,
  fps: number,
  preFilter = '',
  window?: MatteWindow,
  /** `bgr24` for the pose models, which take OpenCV's channel order. */
  pixFmt: 'rgb24' | 'bgr24' = 'rgb24'
): string[] {
  const vf = [`fps=${fps}`, preFilter, `scale=${w}:${h}:flags=bicubic`].filter(Boolean).join(',')
  return [
    '-hide_banner',
    '-nostdin',
    ...windowArgs(window),
    '-i',
    input,
    '-vf',
    vf,
    '-f',
    'rawvideo',
    '-pix_fmt',
    pixFmt,
    'pipe:1'
  ]
}

/**
 * Encode straight-alpha RGBA frames (read from stdin) to a VP9 yuva420p WebM.
 * With `audio`, the same source window's first audio stream is muxed in as Opus
 * (WebM's codec; the export's alpha path uses it too), so a matted clip keeps
 * its sound and can stand in for the original layer.
 */
export function buildMatteEncodeArgs(
  output: string,
  w: number,
  h: number,
  fps: number,
  audio?: { input: string; window?: MatteWindow }
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${w}x${h}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
    ...(audio ? [...windowArgs(audio.window), '-i', audio.input, '-map', '0:v:0', '-map', '1:a:0'] : []),
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-b:v',
    '0',
    '-crf',
    '20',
    '-deadline',
    'good',
    '-cpu-used',
    '2',
    '-row-mt',
    '1',
    ...(audio ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-an']),
    output
  ]
}

/**
 * Reassemble fixed-size frames from a raw pipe's arbitrary chunks, copying each
 * chunk once into ONE preallocated frame buffer (re-concatenating the partial
 * frame per ~64 KB chunk copied ~300 MB per 1080×1920 frame and dominated the
 * job). The yielded buffer is REUSED: it is only valid until the next
 * iteration, so consume it (e.g. `frameToSrcTensor`) before asking for more.
 * Iterating the stream honours backpressure — the pipe is paused while the
 * consumer works. A trailing partial frame is dropped.
 */
export async function* rawFrames(chunks: AsyncIterable<Uint8Array>, frameBytes: number): AsyncGenerator<Uint8Array> {
  const frame = new Uint8Array(frameBytes)
  let filled = 0
  for await (const chunk of chunks) {
    let off = 0
    while (off < chunk.length) {
      const n = Math.min(frameBytes - filled, chunk.length - off)
      frame.set(chunk.subarray(off, off + n), filled)
      filled += n
      off += n
      if (filled === frameBytes) {
        yield frame
        filled = 0
      }
    }
  }
}

/**
 * One rgb24 HWC frame (w*h*3 bytes) → RVM `src` data: CHW, RGB, normalised
 * [0,1]. Pass `out` (length 3*w*h) to fill a reused buffer instead of
 * allocating ~24 MB per 1080×1920 frame.
 */
export function frameToSrcTensor(
  rgb: Uint8Array,
  w: number,
  h: number,
  out: Float32Array = new Float32Array(3 * w * h)
): Float32Array {
  const wh = w * h
  const k = 1 / 255
  for (let i = 0, j = 0; i < wh; i++, j += 3) {
    out[i] = rgb[j] * k // R plane
    out[wh + i] = rgb[j + 1] * k // G plane
    out[2 * wh + i] = rgb[j + 2] * k // B plane
  }
  return out
}

/**
 * RVM outputs — foreground `fgr` (CHW, [0,1]) and alpha `pha` ([0,1]) — → a
 * straight-alpha RGBA HWC frame (w*h*4 bytes) for the WebM encoder. Straight (not
 * premultiplied) alpha, which is what rawvideo `rgba`→`yuva420p` expects. The
 * clamp to [0,255] and rounding are the engine's own Uint8ClampedArray store
 * (round-half-to-even), several times faster than doing them per channel in JS.
 */
export function compositeRgba(fgr: Float32Array, pha: Float32Array, w: number, h: number): Uint8Array {
  const wh = w * h
  const out = new Uint8ClampedArray(wh * 4)
  for (let i = 0, j = 0; i < wh; i++, j += 4) {
    out[j] = fgr[i] * 255
    out[j + 1] = fgr[wh + i] * 255
    out[j + 2] = fgr[2 * wh + i] * 255
    out[j + 3] = pha[i] * 255
  }
  return new Uint8Array(out.buffer)
}
