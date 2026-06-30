/**
 * Pure ffmpeg filtergraph fragment builders + numeric formatters shared by the
 * export arg builder, the exporter, and the still grabber. Centralising these
 * keeps the exact filter strings (which the `exporterArgs` tests pin) defined
 * once, so a tweak to crop/eq/rounding can't drift between callers.
 *
 * If you're about to hand-write `crop=…`, `eq=…`, `n.toFixed(3)`, or
 * `Math.round` for an ffmpeg arg, import from here instead. @see docs/SHARED.md
 */

/** Round to an integer — ffmpeg pixel geometry (overlay x/y, scale w/h, crop). */
export const r = (n: number): number => Math.round(n)

/** Fixed 3-decimal string — ffmpeg seconds / fractions (-ss, -t, setpts, enable). */
export const f3 = (n: number): string => n.toFixed(3)

/** `crop=w:h:x:y` with integer pixel geometry. */
export function cropFilter(c: { x: number; y: number; w: number; h: number }): string {
  return `crop=${r(c.w)}:${r(c.h)}:${r(c.x)}:${r(c.y)}`
}

/** `eq=brightness=…:contrast=…:saturation=…` color-correction filter. */
export function eqFilter(c: { brightness: number; contrast: number; saturation: number }): string {
  return `eq=brightness=${c.brightness}:contrast=${c.contrast}:saturation=${c.saturation}`
}
