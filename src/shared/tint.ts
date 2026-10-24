/**
 * Clip tint (sepia and friends): wash a video clip toward one colour. ONE 3×3
 * RGB matrix drives both sides, so the preview and the export cannot drift —
 * the preview applies it as an SVG `feColorMatrix` (in sRGB, after the CSS
 * brightness/contrast/saturate chain), the export as `colorchannelmixer`
 * (after `eq`), both on the same non-linear sRGB values. Verified against the
 * real binary (docs/FFMPEG-NOTES.md "Clip tint").
 *
 * The tinted picture is the pixel's luma (Rec. 709 weights) times the tint
 * colour, mixed with the original by `amount`: 0 leaves the clip alone, 1 is a
 * pure duotone from black to the tint colour.
 */

import { clamp01 } from './math'

export interface Tint {
  /** `#rrggbb` — what white becomes at full strength. */
  color: string
  /** Strength 0..1 (0 = no tint). */
  amount: number
}

/** The Inspector's starting point: a warm, old-photo sepia at 60%. */
export const DEFAULT_TINT: Tint = { color: '#e8c290', amount: 0.6 }

/** Rec. 709 luma weights. */
const LUMA = [0.2126, 0.7152, 0.0722] as const

/** `#rrggbb` (or `#rgb`, `#rrggbbaa` — alpha ignored) as 0..1 channels; black for anything unreadable. */
export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return [0, 0, 0]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/** Whether `t` changes the picture at all. */
export function isNeutralTint(t: Tint | null | undefined): boolean {
  return !t || clamp01(t.amount) === 0
}

/**
 * The tint as a row-major 3×3 matrix over RGB (`out_r = m[0]·r + m[1]·g + m[2]·b`, …):
 * `(1 − a)·I + a·T·Lᵀ`, with T the tint colour and L the luma weights.
 * Rounded to 6 places so both sides print the same numbers.
 */
export function tintMatrix(t: Tint): number[] {
  const a = clamp01(t.amount)
  const tc = hexToRgb01(t.color)
  const m: number[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const v = (row === col ? 1 - a : 0) + a * tc[row] * LUMA[col]
      m.push(Math.round(v * 1e6) / 1e6)
    }
  }
  return m
}

/** The SVG `feColorMatrix` `values` (a 4×5 matrix: RGB from `tintMatrix`, alpha untouched). */
export function tintFeColorMatrix(t: Tint): string {
  const m = tintMatrix(t)
  const rows = [0, 1, 2].map((r) => [m[r * 3], m[r * 3 + 1], m[r * 3 + 2], 0, 0].join(' '))
  return [...rows, '0 0 0 1 0'].join(' ')
}
