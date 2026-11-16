/**
 * Clip colour grade (the Inspector's Exposure / Contrast / Saturation sliders,
 * `ColorAdjust`): ONE definition for the preview and the export, so the picture
 * you tune is the picture that exports. The REFERENCE is what Chromium draws for
 * the CSS filter chain `brightness(1 + b) contrast(c) saturate(s)` — the preview
 * uses `gradeCssFilter` as is; the export rebuilds the same three steps from the
 * pieces below (`lutrgb` for the curve, `colorchannelmixer` for the saturation
 * matrix; `ffmpegFilters.ts`). Both are the W3C Filter Effects definitions,
 * checked against real Chromium and real ffmpeg (docs/FFMPEG-NOTES.md "Clip
 * grade").
 *
 * The steps run on non-linear sRGB values, in this order, each CLAMPED to the
 * channel range before the next:
 *   1. exposure   out = in · (1 + b)                 (multiplies — not an offset)
 *   2. contrast   out = c · in + 0.5 · (1 − c)       (about mid grey, 0..1 scale)
 *   3. saturation a 3×3 matrix over RGB (below)
 * Then the clip's tint (`shared/tint.ts`) follows.
 */

import { clamp01 } from './math'
import { isNeutralColor, type ColorAdjust } from './project'

/** Round to 6 places so the preview, the export string and the tests print the same numbers. */
const n6 = (v: number): number => Math.round(v * 1e6) / 1e6

/** The most saturation a grade applies — the Inspector slider's top. Above
 *  about 2.08 a matrix entry leaves `colorchannelmixer`'s −2..2 range and the
 *  export would fail, so a value from outside the UI (a hand-edited project, a
 *  template) is held here on BOTH sides. */
export const MAX_GRADE_SATURATION = 2

/** A grade's saturation as both sides apply it (0..`MAX_GRADE_SATURATION`). */
const gradeSaturation = (saturation: number): number => Math.min(MAX_GRADE_SATURATION, Math.max(0, saturation))

/** The preview's CSS `filter` value for a grade (what the export must match). */
export function gradeCssFilter(c: ColorAdjust): string {
  // A negative brightness() is invalid CSS and would drop the whole filter.
  return `brightness(${Math.max(0, 1 + c.brightness)}) contrast(${c.contrast}) saturate(${gradeSaturation(c.saturation)})`
}

/** Exposure gain and contrast: `out = clamp(contrast · clamp(gain · in) + offset)` on a 0..1 scale. */
export interface GradeCurve {
  gain: number
  contrast: number
  offset: number
}

/** The per-channel curve (steps 1 and 2) — the same for R, G and B. `null` when both are neutral. */
export function gradeCurve(c: ColorAdjust): GradeCurve | null {
  if (c.brightness === 0 && c.contrast === 1) return null
  const gain = n6(Math.max(0, 1 + c.brightness))
  return { gain, contrast: n6(c.contrast), offset: n6(0.5 * (1 - c.contrast)) }
}

/**
 * The saturation matrix (step 3), row-major (`out_r = m[0]·r + m[1]·g + m[2]·b`, …):
 * the Filter Effects `saturate(s)` matrix, Rec. 601-style luma weights
 * (0.213 / 0.715 / 0.072) — NOT the Rec. 709 weights the tint uses. `null` at 1.
 */
export function gradeSaturationMatrix(saturation: number): number[] | null {
  const s = gradeSaturation(saturation)
  if (s === 1) return null
  return [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s
  ].map(n6)
}

/**
 * The grade applied to one 8-bit RGB colour — the pure reference the tests pin
 * to the measured Chromium output. Chromium floors after exposure and contrast
 * (each stage is held as an 8-bit value) and rounds after saturation; this does
 * the same. Measured over 16 colours × 13 grades it matches Chromium exactly
 * except where Chromium's float32 arithmetic lands one level low on an exact
 * integer (contrast 0.6 on black: 50, not 51), so treat it as within 1 level.
 */
export function applyGrade(c: ColorAdjust, rgb: readonly [number, number, number]): [number, number, number] {
  if (isNeutralColor(c)) return [rgb[0], rgb[1], rgb[2]]
  const clamp255 = (v: number): number => clamp01(v / 255) * 255
  const curve = gradeCurve(c)
  let v = [...rgb] as number[]
  if (curve) {
    // The 1e-9 keeps double-precision noise on exact integers from flooring a level low.
    v = v.map((x) => Math.floor(clamp255(x * curve.gain) + 1e-9))
    v = v.map((x) => Math.floor(clamp255(curve.contrast * x + curve.offset * 255) + 1e-9))
  }
  const m = gradeSaturationMatrix(c.saturation)
  if (m) {
    const [r, g, b] = v
    v = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b].map((x) =>
      Math.round(clamp255(x))
    )
  }
  return [v[0], v[1], v[2]]
}
