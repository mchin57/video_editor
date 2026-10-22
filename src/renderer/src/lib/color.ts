/**
 * `#rrggbb[aa]` helpers for colours that carry alpha (a text pill, a shape's
 * fill): `<input type="color">` only takes the six-digit part, so the alpha is
 * split off for its own slider and put back on change. @see docs/SHARED.md
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
