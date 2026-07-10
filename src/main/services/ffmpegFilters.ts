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

/**
 * Piecewise-LINEAR ramp of `v` over time as a nested-if ffmpeg expression in
 * `t` (holds the first/last value outside the range) — the export twin of
 * `layerTransformAt`'s interpolation. The result contains commas, so the
 * caller must place it inside a single-quoted option value
 * (`x='…'`), NOT bare in a filtergraph. Times are absolute output seconds.
 */
export function piecewiseLinearExpr(points: { t: number; v: number }[]): string {
  if (points.length === 0) return '0'
  const p = [...points].sort((a, b) => a.t - b.t)
  if (p.length === 1) return f3(p[0].v)
  let expr = f3(p[p.length - 1].v) // after the last point: hold its value
  // Build inside-out: each earlier segment wraps the rest in one if().
  for (let i = p.length - 2; i >= 0; i--) {
    const a = p[i]
    const b = p[i + 1]
    const span = b.t - a.t
    const seg =
      span > 0
        ? `${f3(a.v)}+${f3(b.v - a.v)}*(t-${f3(a.t)})/${f3(span)}`
        : f3(b.v)
    expr = `if(lt(t,${f3(b.t)}),${seg},${expr})`
  }
  return `if(lt(t,${f3(p[0].t)}),${f3(p[0].v)},${expr})`
}
