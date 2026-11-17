/**
 * `#rrggbb[aa]` helpers for colours that carry alpha (a text pill, a shape's
 * fill): `<input type="color">` only takes the six-digit part, so the alpha is
 * split off for its own slider and put back on change. Also `lerpColor`, which
 * a shape's colour keyframes blend with on both the preview and the export.
 * Pure — imported by both sides. @see docs/SHARED.md
 */

/** The colour part of a `#rrggbb[aa]` value (what `<input type="color">` takes). */
export const hex6 = (c: string): string => '#' + c.replace('#', '').slice(0, 6).padEnd(6, '0')

/** The alpha byte (0..255) of a `#rrggbbaa` value; a six-digit colour is opaque. */
export const getAlpha = (c: string): number => {
  const h = c.replace('#', '')
  return h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255
}

/** `c`'s colour with alpha byte `a` (clamped to 0..255). */
export const withAlpha = (c: string, a: number): string =>
  hex6(c) +
  Math.max(0, Math.min(255, Math.round(a)))
    .toString(16)
    .padStart(2, '0')

const channels = (c: string): [number, number, number, number] => {
  const h = hex6(c).slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0).concat(getAlpha(c)) as [
    number,
    number,
    number,
    number
  ]
}

const byte = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, '0')

/**
 * The colour `f` (0..1) of the way from `a` to `b`: a per-channel RGBA blend of
 * two `#rrggbb` / `#rrggbbaa` values (a missing alpha is `ff`). Returns lowercase
 * `#rrggbb` when the result is fully opaque, else `#rrggbbaa` — so a blend of
 * two opaque colours stays a plain six-digit colour.
 */
export function lerpColor(a: string, b: string, f: number): string {
  const ca = channels(a)
  const cb = channels(b)
  const m = ca.map((v, i) => v + (cb[i] - v) * f)
  const rgb = '#' + byte(m[0]) + byte(m[1]) + byte(m[2])
  const alpha = Math.max(0, Math.min(255, Math.round(m[3])))
  return alpha === 255 ? rgb : rgb + byte(alpha)
}
