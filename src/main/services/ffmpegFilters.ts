/**
 * Pure ffmpeg filtergraph fragment builders + numeric formatters shared by the
 * export arg builder, the exporter, and the still grabber. Centralising these
 * keeps the exact filter strings (which the `exporterArgs` tests pin) defined
 * once, so a tweak to crop/eq/rounding can't drift between callers.
 *
 * If you're about to hand-write `crop=…`, `lutrgb=…`, `n.toFixed(3)`, or
 * `Math.round` for an ffmpeg arg, import from here instead. @see docs/SHARED.md
 */

import { isNeutralColor, type ColorAdjust } from '@shared/project'
import { gradeCurve, gradeSaturationMatrix } from '@shared/grade'
import { isNeutralTint, tintMatrix, type Tint } from '@shared/tint'
import { isSilenceDb, type LinePoint } from '@shared/audioEnvelope'

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

/**
 * Free-angle layer rotation: `rotate` by `deg` CLOCKWISE (ffmpeg's positive
 * direction), grown to the rotated bounds (`rotw`/`roth`, rounded up to even)
 * with a TRANSPARENT fill (`c=none`). The input must carry alpha (yuva/rgba)
 * or the corners come out black. Verified against ffmpeg 8.1.1 — see
 * FFMPEG-NOTES "Layer rotation".
 */
export function rotateFilter(deg: number): string {
  const a = f6((deg * Math.PI) / 180)
  return `rotate=a=${a}:ow='ceil(rotw(${a})/2)*2':oh='ceil(roth(${a})/2)*2':c=none`
}

/**
 * A clip's colour grade (exposure, contrast, saturation) as ffmpeg filters that
 * reproduce the preview's CSS `brightness() contrast() saturate()` chain — the
 * shared definition in `shared/grade.ts`: a `lutrgb` for the per-channel
 * exposure + contrast curve (clamped between the two), then a
 * `colorchannelmixer` for the saturation matrix. `maxval` keeps the curve right
 * at any bit depth; ffmpeg converts YUV to RGB around both by itself and alpha
 * passes through. Replaces `eq`, which ADDS brightness where the preview
 * multiplies. Verified against ffmpeg 8.1.1 and Chromium — see FFMPEG-NOTES
 * "Clip grade". '' for a neutral grade.
 */
export function gradeColorFilter(c: ColorAdjust): string {
  const parts: string[] = []
  const curve = gradeCurve(c)
  if (curve) {
    const { gain, contrast, offset } = curve
    const scaled = gain === 1 ? 'val' : `val*${gain}`
    let e: string
    if (contrast === 1) e = `clip(${scaled},0,maxval)`
    else {
      // Exposure above 1 can overshoot, so it clamps BEFORE contrast (as Chromium does between its filters).
      const exposed = gain > 1 ? `clip(${scaled},0,maxval)` : scaled
      const shifted = offset >= 0 ? `+${offset}*maxval` : `-${-offset}*maxval`
      e = `clip(${exposed}*${contrast}${shifted},0,maxval)`
    }
    parts.push(`lutrgb=r='${e}':g='${e}':b='${e}'`)
  }
  const sat = gradeSaturationMatrix(c.saturation)
  if (sat) parts.push(mixerFilter(sat))
  return parts.join(',')
}

/** `colorchannelmixer` rows from a row-major 3×3 RGB matrix (alpha left alone). */
function mixerFilter(m: number[]): string {
  const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb']
  return `colorchannelmixer=${names.map((n, i) => `${n}=${m[i]}`).join(':')}`
}

/**
 * A clip tint as `colorchannelmixer` (RGB rows from `tintMatrix`, alpha left
 * alone) — the export twin of the preview's `feColorMatrix`. ffmpeg converts a
 * YUV stream to RGB around it by itself. Verified against ffmpeg 8.1.1 — see
 * FFMPEG-NOTES "Clip tint".
 */
export function tintFilter(t: Tint): string {
  return mixerFilter(tintMatrix(t))
}

/** The colour-grade fragment for a clip: the grade (`gradeColorFilter`) then the
 *  tint, either optional ('' when the clip is ungraded). A look that needs the
 *  colour table (a newer control, a LUT) is not this: see `exportGrade.ts`. */
export function gradeFilter(color: ColorAdjust | null | undefined, tint: Tint | null | undefined): string {
  const parts: string[] = []
  const grade = color && !isNeutralColor(color) ? gradeColorFilter(color) : ''
  if (grade) parts.push(grade)
  if (tint && !isNeutralTint(tint)) parts.push(tintFilter(tint))
  return parts.join(',')
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
    cum.push(cum[i] + (span <= 0 ? 0 : Math.abs(m) < 1e-9 ? span / p[i].v : Math.log(p[i + 1].v / p[i].v) / m))
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

/**
 * sendcmd command lines driving a `colorchannelmixer@<id>` alpha (`aa`) ramp —
 * the per-frame opacity path (verified ffmpeg 8.1.1, see FFMPEG-NOTES
 * "Keyframed opacity"). One `[expr]` interval per keyframe segment (`TI` is
 * the 0..1 progress, re-evaluated every frame), plus a constant TAIL interval
 * pinning the last value — without it the final frame of the last segment
 * undershoots (TI never reaches 1) and sticks there. Times are the ABSOLUTE
 * output seconds the target stream's (setpts-shifted) frames carry. Returns ''
 * when fewer than 2 points (the filter's initial `aa=` covers a constant).
 */
export function buildOpacityCmdLines(id: string, points: { t: number; o: number }[]): string {
  const p = [...points].sort((a, b) => a.t - b.t)
  if (p.length < 2) return ''
  const lines: string[] = []
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i]
    const b = p[i + 1]
    if (b.t - a.t <= 0.001) continue
    lines.push(`${f3(a.t)}-${f3(b.t)} [expr] colorchannelmixer@${id} aa 'lerp(${f3(a.o)},${f3(b.o)},TI)';`)
  }
  const last = p[p.length - 1]
  lines.push(`${f3(last.t)}-${f3(last.t + 3600)} [expr] colorchannelmixer@${id} aa '${f3(last.o)}';`)
  return lines.join('\n') + '\n'
}

/**
 * An audio clip's VOLUME LINE as a linear-gain ffmpeg expression in `t` (the
 * export twin of `lineGainAt`, shared/audioEnvelope.ts — keep them in lockstep):
 * straight lines in dB between points as `pow(10,(dB)/20)`, the first/last
 * value held outside, and a hold or a stretch wholly at silence as `0`. Same
 * `lt()` nesting as `piecewiseLinearExpr`, so a segment covers [a, b). Times are
 * absolute timeline seconds — the `volume` filter must sit AFTER the clip's
 * `adelay,asetpts` and run with `eval=frame` (FFMPEG-NOTES "Volume line"). The
 * result contains commas: single-quote it.
 */
export function volumeLineExpr(points: LinePoint[]): string {
  if (points.length === 0) return '1'
  const p = [...points].sort((a, b) => a.t - b.t)
  const hold = (db: number): string => (isSilenceDb(db) ? '0' : f6(Math.pow(10, db / 20)))
  let expr = hold(p[p.length - 1].db)
  if (p.length === 1) return expr
  for (let i = p.length - 2; i >= 0; i--) {
    const a = p[i]
    const b = p[i + 1]
    const span = b.t - a.t
    const seg =
      isSilenceDb(a.db) && isSilenceDb(b.db)
        ? '0'
        : span > 0
          ? `pow(10,(${f3(a.db)}+${f3(b.db - a.db)}*(t-${f3(a.t)})/${f3(span)})/20)`
          : hold(b.db)
    expr = `if(lt(t,${f3(b.t)}),${seg},${expr})`
  }
  return `if(lt(t,${f3(p[0].t)}),${hold(p[0].db)},${expr})`
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
    const seg = span > 0 ? `${f3(a.v)}+${f3(b.v - a.v)}*(t-${f3(a.t)})/${f3(span)}` : f3(b.v)
    expr = `if(lt(t,${f3(b.t)}),${seg},${expr})`
  }
  return `if(lt(t,${f3(p[0].t)}),${f3(p[0].v)},${expr})`
}
