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

/** Fixed 6-decimal string — speed-ramp integral constants, where 3 decimals
 *  would visibly drift the mapping over a long clip. */
export const f6 = (n: number): string => n.toFixed(6)

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
/**
 * Played-time expression for a speed RAMP, in trimmed-input seconds: given the
 * clip's speed profile as boundary points `{u, v}` (u = source seconds since
 * the in-point, ≥ 2 points spanning the whole trim), returns an ffmpeg
 * expression in `T-STARTT` evaluating the integral of 1/speed — piecewise
 * `C_i + (x−u_i)/v_i` for flat segments, `C_i + log(v(x)/v_i)/m_i` for ramped
 * ones (ffmpeg `log` is natural log — verified, see FFMPEG-NOTES "Speed
 * ramps"). Values past the last boundary hold the total (stray end frames
 * would otherwise extrapolate `log` of a possibly-negative speed). Contains
 * commas — the caller must place the whole setpts value in single quotes.
 * The export twin of `playedBetween` (`shared/speed.ts`) — keep them in
 * lockstep.
 */
export function speedRampPlayedExpr(points: { u: number; v: number }[], x = 'T-STARTT'): string {
  const p = [...points].sort((a, b) => a.u - b.u)
  if (p.length < 2) return '0'
  // Cumulative played time at each boundary (same closed forms as shared/speed).
  const cum: number[] = [0]
  for (let i = 0; i < p.length - 1; i++) {
    const span = p[i + 1].u - p[i].u
    const m = span > 0 ? (p[i + 1].v - p[i].v) / span : 0
    cum.push(
      cum[i] +
        (span <= 0 ? 0 : Math.abs(m) < 1e-9 ? span / p[i].v : Math.log(p[i + 1].v / p[i].v) / m)
    )
  }
  let expr = f6(cum[cum.length - 1]) // past the last boundary: hold the total
  for (let i = p.length - 2; i >= 0; i--) {
    const a = p[i]
    const b = p[i + 1]
    const span = b.u - a.u
    const m = span > 0 ? (b.v - a.v) / span : 0
    const seg =
      span <= 0
        ? f6(cum[i + 1])
        : Math.abs(m) < 1e-9
          ? `${f6(cum[i])}+(${x}-${f6(a.u)})/${f6(a.v)}`
          : `${f6(cum[i])}+log((${f6(a.v)}+${f6(m)}*(${x}-${f6(a.u)}))/${f6(a.v)})/${f6(m)}`
    expr = `if(lt(${x},${f6(b.u)}),${seg},${expr})`
  }
  return expr
}

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
