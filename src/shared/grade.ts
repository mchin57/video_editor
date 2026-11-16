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
 *
 * THE COLOUR TABLE. A grade that uses a newer control (temperature, green /
 * magenta, vibrance) or a `.cube` LUT can't be drawn with CSS filters, so the
 * WHOLE look — steps 1–3 exactly as `applyGrade` does them, then the white
 * balance, vibrance, the colour wash, and the LUT at its strength — is baked
 * into one 3D table (`bakeGradeTable`, `GRADE_TABLE_SIZE` points a side). The
 * export applies it with ffmpeg `lut3d`, the preview with a WebGL shader doing
 * `lut3d`'s own tetrahedral lookup, so the two agree by construction (within 1
 * level on every 24-bit colour; FFMPEG-NOTES "Colour table"). A grade that uses
 * only the first three sliders and the wash keeps the CSS / `lutrgb` paths
 * above, byte for byte (`needsGradeTable`).
 */

import { clamp01 } from './math'
import {
  hasNewColorControls,
  isNeutralColor,
  type ColorAdjust,
  type ImageContent,
  type LutRef,
  type VideoContent
} from './project'
import { isNeutralTint, tintMatrix } from './tint'
import { n6 as cubeN6, sampleCube, type CubeTable } from './cube'

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
  const v = gradePixel255(c, rgb)
  return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]
}

const clamp255 = (v: number): number => clamp01(v / 255) * 255

/**
 * Steps 1–3 on one colour in 0..255, the way Chromium does them: the value is
 * held as an 8-bit integer (FLOORED) after exposure and after contrast; the
 * saturation result is left unrounded (`applyGrade` rounds it, as Chromium
 * does; the colour table keeps it continuous and the lookup floors at the
 * end, as `lut3d` does). Inputs need not be integers — the table bakes it at
 * its grid points.
 */
export function gradePixel255(c: ColorAdjust, rgb: readonly number[]): number[] {
  const curve = gradeCurve(c)
  let v = [rgb[0], rgb[1], rgb[2]]
  if (curve) {
    // The 1e-9 keeps double-precision noise on exact integers from flooring a level low.
    v = v.map((x) => Math.floor(clamp255(x * curve.gain) + 1e-9))
    v = v.map((x) => Math.floor(clamp255(curve.contrast * x + curve.offset * 255) + 1e-9))
  }
  const m = gradeSaturationMatrix(c.saturation)
  if (m) {
    const [r, g, b] = v
    v = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b].map(clamp255)
  }
  return v
}

// --- The newer controls (the colour table only) ------------------------------

/** How far the ends of the Temperature and Tint sliders move a channel's
 *  LINEAR-light gain (±30 %), before the gains are rescaled to keep grey's
 *  luminance. */
const WB_REACH = 0.3

/** Rec. 709 luma weights — linear-light luminance for the gains, and the
 *  vibrance pivot (as the wash, shared/tint.ts). */
const LUMA_709 = [0.2126, 0.7152, 0.0722] as const

/** The sRGB transfer curve (IEC 61966-2-1), exactly: encoded 0..1 → linear light, and back. */
const decodeExact = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const encodeExact = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

/** Both curves as 4096-step tables read with linear interpolation — the bake
 *  runs them 65³ × 3 times a slider move, and `Math.pow` was most of its cost.
 *  The encode table is indexed by √v so its steps crowd where the curve bends
 *  (both stay within 1e-7 of the exact curve: far below an 8-bit level). */
const TF_STEPS = 4096
const DECODE = Float64Array.from({ length: TF_STEPS + 1 }, (_, i) => decodeExact(i / TF_STEPS))
const ENCODE = Float64Array.from({ length: TF_STEPS + 1 }, (_, i) => encodeExact((i / TF_STEPS) ** 2))
function interpTable(t: Float64Array, x: number): number {
  const p = Math.max(0, Math.min(1, x)) * TF_STEPS
  const i = Math.min(Math.floor(p), TF_STEPS - 1)
  return t[i] + (t[i + 1] - t[i]) * (p - i)
}
/** sRGB-encoded 0..1 → linear light (0..1, clamped). */
export const srgbToLinear = (v: number): number => interpTable(DECODE, v)
/** Linear light 0..1 → sRGB-encoded (clamped). */
export const linearToSrgb = (v: number): number => interpTable(ENCODE, Math.sqrt(Math.max(0, v)))

/**
 * Temperature (−1 cool … 1 warm) and green / magenta (−1 green … 1 magenta)
 * as one white-balance step: per-channel gains in LINEAR light — warm raises
 * red and lowers blue, magenta lowers green — divided by their luminance so a
 * grey keeps its brightness. `null` when both are 0. The colour is decoded
 * from sRGB, multiplied, clamped and encoded again (`applyWhiteBalance`).
 */
export function whiteBalanceGains(temperature = 0, greenMagenta = 0): [number, number, number] | null {
  const t = Math.max(-1, Math.min(1, temperature))
  const m = Math.max(-1, Math.min(1, greenMagenta))
  if (t === 0 && m === 0) return null
  const raw = [1 + WB_REACH * t, 1 - WB_REACH * m, 1 - WB_REACH * t]
  const y = LUMA_709[0] * raw[0] + LUMA_709[1] * raw[1] + LUMA_709[2] * raw[2]
  return [raw[0] / y, raw[1] / y, raw[2] / y]
}

/** The white-balance step on one 0..1 colour (see `whiteBalanceGains`). */
export function applyWhiteBalance(gains: readonly number[], rgb: readonly number[]): number[] {
  return [0, 1, 2].map((c) => linearToSrgb(clamp01(srgbToLinear(clamp01(rgb[c])) * gains[c])))
}

/**
 * Vibrance (−1 … 1) on one 0..1 colour: a saturation change about the colour's
 * luma, scaled by how MUTED it is — `k = 1 + v · (1 − sat)`, sat = max − min —
 * so a positive value lifts dull colours most and leaves fully saturated ones
 * alone, and a negative one greys the dull colours first. (ffmpeg's `vibrance`
 * filter uses the same idea but its negative side inverts strong colours; it is
 * not used.) Greys never move.
 */
export function applyVibrance(vibrance: number, rgb: readonly number[]): number[] {
  const v = Math.max(-1, Math.min(1, vibrance))
  const sat = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
  const k = Math.max(0, 1 + v * (1 - sat))
  const luma = LUMA_709[0] * rgb[0] + LUMA_709[1] * rgb[1] + LUMA_709[2] * rgb[2]
  return [0, 1, 2].map((c) => clamp01(luma + (rgb[c] - luma) * k))
}

// --- The colour table ---------------------------------------------------------

/** Points per side of the baked table: 65 keeps the old sliders within a few
 *  levels of their CSS / `lutrgb` look where 33 drifted up to 11 (FFMPEG-NOTES
 *  "Colour table"), and lines up with a 33-point user LUT (every other point). */
export const GRADE_TABLE_SIZE = 65

/** What the Color section sets on a video clip or an image. */
export type ColorLook = Pick<VideoContent | ImageContent, 'color' | 'tint' | 'lut'>

/** The LUT when it does anything (a reference at strength 0 is no LUT). */
export const activeLut = (lut: LutRef | null | undefined): LutRef | null => (lut && lut.strength > 0 ? lut : null)

/**
 * Whether this look must be drawn through the colour table: it uses a newer
 * control or a LUT. Anything else — the first three sliders and the wash —
 * keeps the CSS preview and the `lutrgb` / `colorchannelmixer` export.
 */
export function needsGradeTable(look: ColorLook): boolean {
  return hasNewColorControls(look.color) || !!activeLut(look.lut)
}

/**
 * The whole look as a function of one 0..1 colour, in order: exposure /
 * contrast / saturation (`gradePixel255`, Chromium's floors and all), white
 * balance, vibrance, the colour wash (its 3×3 matrix), then the LUT, mixed in
 * at its strength. Clamped to 0..1. `lut` is the parsed file `look.lut` names
 * (null = skip the LUT, e.g. while it loads).
 */
export function lookFunction(
  look: ColorLook,
  lut: CubeTable | null
): (rgb: readonly number[], out?: number[]) => number[] {
  const c = look.color && !isNeutralColor(look.color) ? look.color : null
  const curve = c ? gradeCurve(c) : null
  const sat = c ? gradeSaturationMatrix(c.saturation) : null
  const gains = c ? whiteBalanceGains(c.temperature, c.greenMagenta) : null
  const vib = c ? Math.max(-1, Math.min(1, c.vibrance ?? 0)) : 0
  const wash = look.tint && !isNeutralTint(look.tint) ? tintMatrix(look.tint) : null
  const ref = activeLut(look.lut)
  const table = ref ? lut : null
  const strength = ref ? clamp01(ref.strength) : 0
  const tmp = [0, 0, 0]
  // Scalar on purpose: the preview bakes 65³ colours whenever a slider moves.
  // Each step is the SAME arithmetic as its reference helper above
  // (`gradePixel255`, `applyWhiteBalance`, `applyVibrance`); grade.test.ts
  // holds them equal.
  return (rgb, out = [0, 0, 0]) => {
    let r = rgb[0]
    let g = rgb[1]
    let b = rgb[2]
    if (curve || sat) {
      r *= 255
      g *= 255
      b *= 255
      if (curve) {
        r = Math.floor(clamp255(r * curve.gain) + 1e-9)
        g = Math.floor(clamp255(g * curve.gain) + 1e-9)
        b = Math.floor(clamp255(b * curve.gain) + 1e-9)
        const o = curve.offset * 255
        r = Math.floor(clamp255(curve.contrast * r + o) + 1e-9)
        g = Math.floor(clamp255(curve.contrast * g + o) + 1e-9)
        b = Math.floor(clamp255(curve.contrast * b + o) + 1e-9)
      }
      if (sat) {
        const r0 = r
        const g0 = g
        r = clamp255(sat[0] * r0 + sat[1] * g0 + sat[2] * b)
        g = clamp255(sat[3] * r0 + sat[4] * g0 + sat[5] * b)
        b = clamp255(sat[6] * r0 + sat[7] * g0 + sat[8] * b)
      }
      r /= 255
      g /= 255
      b /= 255
    }
    if (gains) {
      r = linearToSrgb(clamp01(srgbToLinear(clamp01(r)) * gains[0]))
      g = linearToSrgb(clamp01(srgbToLinear(clamp01(g)) * gains[1]))
      b = linearToSrgb(clamp01(srgbToLinear(clamp01(b)) * gains[2]))
    }
    if (vib) {
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)
      const k = Math.max(0, 1 + vib * (1 - chroma))
      const luma = LUMA_709[0] * r + LUMA_709[1] * g + LUMA_709[2] * b
      r = clamp01(luma + (r - luma) * k)
      g = clamp01(luma + (g - luma) * k)
      b = clamp01(luma + (b - luma) * k)
    }
    if (wash) {
      const r0 = r
      const g0 = g
      r = clamp01(wash[0] * r0 + wash[1] * g0 + wash[2] * b)
      g = clamp01(wash[3] * r0 + wash[4] * g0 + wash[5] * b)
      b = clamp01(wash[6] * r0 + wash[7] * g0 + wash[8] * b)
    }
    if (table) {
      tmp[0] = r
      tmp[1] = g
      tmp[2] = b
      const l = sampleCube(table, tmp, tmp)
      r += (l[0] - r) * strength
      g += (l[1] - g) * strength
      b += (l[2] - b) * strength
    }
    out[0] = clamp01(r)
    out[1] = clamp01(g)
    out[2] = clamp01(b)
    return out
  }
}

/**
 * The look baked into a `size`³ RGB table (red fastest, like a `.cube` file),
 * each value rounded to 6 places — exactly the numbers `writeCube` prints, so
 * the preview's texture and the export's `lut3d` read the same table.
 */
export function bakeGradeTable(look: ColorLook, lut: CubeTable | null, size = GRADE_TABLE_SIZE): Float32Array {
  const f = lookFunction(look, lut)
  const out = new Float32Array(size * size * size * 3)
  const s = size - 1
  const rgb = [0, 0, 0]
  const o = [0, 0, 0]
  let i = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rgb[0] = r / s
        rgb[1] = g / s
        rgb[2] = b / s
        f(rgb, o)
        out[i++] = cubeN6(o[0])
        out[i++] = cubeN6(o[1])
        out[i++] = cubeN6(o[2])
      }
    }
  }
  return out
}
