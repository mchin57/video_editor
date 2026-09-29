/**
 * Variable clip speed (speed RAMPS): pure, dependency-free math shared by the
 * preview and the exporter, so the nonlinear timeline↔source mapping is
 * computed identically on both sides.
 *
 * A ramp is a list of `SpeedKeyframe`s anchored in SOURCE time (like freeze
 * holds, so trims/splits keep the motion). Speed is piecewise-LINEAR between
 * keyframes and holds flat outside the first/last. Played (timeline) time is
 * the integral of 1/speed over source time: for a linear segment
 * `v(s) = v0 + m·(s−s0)` the integral is `ln(v(s)/v0)/m` (or `(s−s0)/v0` when
 * flat), so both directions have exact closed forms (ln one way, exp the
 * other) — no sampling, no drift. The exporter bakes the same piecewise
 * formula into a `setpts` expression (ffmpeg's `log` is natural log —
 * verified, see docs/FFMPEG-NOTES.md "Speed ramps").
 *
 * All timeline↔source conversion goes through these helpers (and the
 * freeze-aware wrappers in `shared/layers.ts`) — never re-derive the mapping
 * inline. @see docs/SHARED.md
 */

import type { SpeedKeyframe, VideoContent } from './project'
import { MAX_VIDEO_SPEED, MIN_VIDEO_SPEED, videoSpeed } from './project'

/** Slopes below this are treated as flat (avoids ln/exp blowup on ~0). */
const FLAT_EPS = 1e-9

/** True when the clip has an active speed ramp (which overrides `speed`). */
export function hasSpeedRamp(c: Pick<VideoContent, 'speedRamp'>): boolean {
  return Array.isArray(c.speedRamp) && c.speedRamp.length > 0
}

const clampSpeed = (v: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0
    ? Math.min(MAX_VIDEO_SPEED, Math.max(MIN_VIDEO_SPEED, v))
    : 1

/** The clip's ramp keyframes, sorted by source time with speeds clamped to the
 *  allowed range. Empty when no ramp. */
export function sortedRamp(c: Pick<VideoContent, 'speedRamp'>): SpeedKeyframe[] {
  if (!hasSpeedRamp(c)) return []
  return [...c.speedRamp!]
    .map((k) => ({ atSec: k.atSec, speed: clampSpeed(k.speed) }))
    .sort((a, b) => a.atSec - b.atSec)
}

/**
 * The slowest speed the profile plays anywhere in source window [a, b]. The
 * profile is piecewise-linear, so the minimum sits at a window edge or at a
 * keyframe inside it — keyframes outside the window don't count.
 */
export function slowestSpeedBetween(c: Pick<VideoContent, 'speed' | 'speedRamp'>, a: number, b: number): number {
  let min = Math.min(videoSpeedAtSource(c, a), videoSpeedAtSource(c, b))
  for (const k of sortedRamp(c)) if (k.atSec > a && k.atSec < b) min = Math.min(min, k.speed)
  return min
}

/**
 * Instantaneous speed at SOURCE second `s`: linear between ramp keyframes,
 * held flat outside them; the constant `videoSpeed` when no ramp.
 */
export function videoSpeedAtSource(
  c: Pick<VideoContent, 'speed' | 'speedRamp'>,
  s: number
): number {
  const kfs = sortedRamp(c)
  if (kfs.length === 0) return videoSpeed(c)
  if (s <= kfs[0].atSec) return kfs[0].speed
  const last = kfs[kfs.length - 1]
  if (s >= last.atSec) return last.speed
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (s <= b.atSec) {
      const span = b.atSec - a.atSec
      const f = span > 0 ? (s - a.atSec) / span : 1
      return a.speed + (b.speed - a.speed) * f
    }
  }
  return last.speed
}

/**
 * One integrable piece of a clip's speed profile over a source interval:
 * speed runs linearly `v0 → v1` across source `[s0, s1]`.
 */
export interface SpeedSegment {
  s0: number
  s1: number
  v0: number
  v1: number
}

/**
 * The clip's speed profile over source `[a, b]` as linear segments with
 * boundaries at `a`, `b`, and every ramp keyframe strictly between them.
 * A constant-speed clip yields one flat segment.
 */
export function speedSegments(
  c: Pick<VideoContent, 'speed' | 'speedRamp'>,
  a: number,
  b: number
): SpeedSegment[] {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const bounds = [lo]
  for (const k of sortedRamp(c)) {
    if (k.atSec > lo + FLAT_EPS && k.atSec < hi - FLAT_EPS) bounds.push(k.atSec)
  }
  bounds.push(hi)
  const segs: SpeedSegment[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    segs.push({
      s0: bounds[i],
      s1: bounds[i + 1],
      v0: videoSpeedAtSource(c, bounds[i]),
      v1: videoSpeedAtSource(c, bounds[i + 1])
    })
  }
  return segs
}

/** Played time consumed by one segment up to source `s` (clamped inside it). */
function segmentPlayed(seg: SpeedSegment, s: number): number {
  const x = Math.min(seg.s1, Math.max(seg.s0, s)) - seg.s0
  const span = seg.s1 - seg.s0
  if (span <= FLAT_EPS) return 0
  const m = (seg.v1 - seg.v0) / span
  if (Math.abs(m) < FLAT_EPS) return x / seg.v0
  return Math.log((seg.v0 + m * x) / seg.v0) / m
}

/** Source point inside one segment after consuming `p` played seconds from its
 *  start (uncapped — the caller checks against the segment's total). */
function segmentSource(seg: SpeedSegment, p: number): number {
  const span = seg.s1 - seg.s0
  if (span <= FLAT_EPS) return seg.s1
  const m = (seg.v1 - seg.v0) / span
  if (Math.abs(m) < FLAT_EPS) return seg.s0 + p * seg.v0
  return seg.s0 + (seg.v0 / m) * (Math.exp(m * p) - 1)
}

/**
 * PLAYED (timeline) seconds the source interval `[a, b]` takes at the clip's
 * speed profile — the integral of 1/speed. Freeze holds are NOT included
 * (they're wall-clock additions layered on top by `shared/layers.ts`).
 * Returns a negative value when `b < a` (signed, so trim deltas compose).
 */
export function playedBetween(
  c: Pick<VideoContent, 'speed' | 'speedRamp'>,
  a: number,
  b: number
): number {
  const total = speedSegments(c, a, b).reduce((sum, seg) => sum + segmentPlayed(seg, seg.s1), 0)
  return b >= a ? total : -total
}

/**
 * SOURCE point reached after playing `played` seconds (freeze holds already
 * removed) from source point `from` — the inverse of `playedBetween`. Signed:
 * negative `played` walks backwards (an edge-drag extending the clip). `limit`
 * caps the result in the direction of travel (an upper bound going forward, a
 * lower bound going backward); beyond the outermost ramp keyframe the flat
 * speed extrapolates in closed form.
 */
export function sourceAfterPlayed(
  c: Pick<VideoContent, 'speed' | 'speedRamp'>,
  from: number,
  played: number,
  limit?: number
): number {
  const kfs = sortedRamp(c)
  if (played >= 0) {
    const hiLimit = limit ?? Number.POSITIVE_INFINITY
    const lastKf = kfs.length ? kfs[kfs.length - 1].atSec : from
    // Segment the profile from `from` up to the last keyframe (beyond it speed
    // is flat, so the tail is a single closed form).
    const hi = Math.max(from, Math.min(hiLimit, lastKf))
    let remaining = played
    for (const seg of speedSegments(c, from, hi)) {
      const segTotal = segmentPlayed(seg, seg.s1)
      if (remaining <= segTotal + FLAT_EPS) {
        return Math.min(hiLimit, Math.min(seg.s1, segmentSource(seg, remaining)))
      }
      remaining -= segTotal
    }
    return Math.min(hiLimit, hi + remaining * videoSpeedAtSource(c, hi))
  }
  const loLimit = limit ?? Number.NEGATIVE_INFINITY
  const firstKf = kfs.length ? kfs[0].atSec : from
  const lo = Math.min(from, firstKf)
  let remaining = -played
  for (const seg of [...speedSegments(c, lo, from)].reverse()) {
    const segTotal = segmentPlayed(seg, seg.s1)
    if (remaining <= segTotal + FLAT_EPS) {
      // Consume from the segment's TOP: solve ∫ s→s1 = remaining via the
      // forward form at (total − remaining).
      return Math.max(loLimit, Math.max(seg.s0, segmentSource(seg, segTotal - remaining)))
    }
    remaining -= segTotal
  }
  return Math.max(loLimit, lo - remaining * videoSpeedAtSource(c, lo))
}
