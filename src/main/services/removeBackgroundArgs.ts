/**
 * PURE helpers for the background-removal (subject matting) job. No onnx/node
 * deps so they can be unit-tested against synthetic frames. Two halves:
 *   - ffmpeg arg builders: decode the source to upright raw RGB frames on stdout,
 *     and encode straight-alpha RGBA frames from stdin to a VP9 (yuva420p) WebM.
 *   - RVM tensor conversions: an rgb24 frame → the model's CHW [0,1] `src` input,
 *     and the model's foreground+alpha outputs → a straight-alpha RGBA frame.
 * The spawn/session orchestration lives in removeBackground.ts.
 */

/** Reels are ≤1080×1920, so the matte is produced at source resolution capped to
 *  this longest edge (never upscaled) — matching the export's native size. */
export const MATTE_MAX_EDGE = 1920

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
 * RVM `downsample_ratio`: the model runs its recurrent guidance on a downsampled
 * copy; the authors recommend a downsampled long edge of ~256–512px. Aim for 512,
 * clamped to [0.25, 1] (1 = don't downsample, for already-small clips).
 */
export function downsampleRatioFor(w: number, h: number): number {
  const r = 512 / Math.max(w, h)
  return Math.min(1, Math.max(0.25, Math.round(r * 1000) / 1000))
}

/**
 * Decode the source to upright (auto-rotated) raw RGB frames at (w,h) and a fixed
 * fps, streamed on stdout. `preFilter` folds in an HDR→SDR tonemap for HDR sources
 * so the model sees sane [0,1] colour (empty = none).
 */
export function buildMatteDecodeArgs(
  input: string,
  w: number,
  h: number,
  fps: number,
  preFilter = ''
): string[] {
  const vf = [preFilter, `scale=${w}:${h}:flags=bicubic`].filter(Boolean).join(',')
  return [
    '-hide_banner',
    '-nostdin',
    '-i',
    input,
    '-vf',
    vf,
    '-r',
    String(fps),
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1'
  ]
}

/** Encode straight-alpha RGBA frames (read from stdin) to a VP9 yuva420p WebM. */
export function buildMatteEncodeArgs(output: string, w: number, h: number, fps: number): string[] {
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
    '-an',
    output
  ]
}

/** One rgb24 HWC frame (w*h*3 bytes) → RVM `src` data: CHW, RGB, normalised [0,1]. */
export function frameToSrcTensor(rgb: Uint8Array, w: number, h: number): Float32Array {
  const wh = w * h
  const out = new Float32Array(3 * wh)
  for (let i = 0; i < wh; i++) {
    out[i] = rgb[i * 3] / 255 // R plane
    out[wh + i] = rgb[i * 3 + 1] / 255 // G plane
    out[2 * wh + i] = rgb[i * 3 + 2] / 255 // B plane
  }
  return out
}

/**
 * RVM outputs — foreground `fgr` (CHW, [0,1]) and alpha `pha` ([0,1]) — → a
 * straight-alpha RGBA HWC frame (w*h*4 bytes) for the WebM encoder. Straight (not
 * premultiplied) alpha, which is what rawvideo `rgba`→`yuva420p` expects.
 */
export function compositeRgba(fgr: Float32Array, pha: Float32Array, w: number, h: number): Uint8Array {
  const wh = w * h
  const out = new Uint8Array(wh * 4)
  const to255 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255))
  for (let i = 0; i < wh; i++) {
    out[i * 4] = to255(fgr[i])
    out[i * 4 + 1] = to255(fgr[wh + i])
    out[i * 4 + 2] = to255(fgr[2 * wh + i])
    out[i * 4 + 3] = to255(pha[i])
  }
  return out
}
