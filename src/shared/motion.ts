/**
 * Simple straight-line motion: a start point, an end point, and the time it
 * takes to travel between them in a straight line at constant speed, holding
 * at the start before and at the end after.
 *
 * There is NO second motion model: a simple move is exactly two
 * `Layer.keyframes` whose positions differ, which video and image layers
 * already honour everywhere (`layerTransformAt`, the export's keyframe path).
 * Text follows the same keyframes for POSITION only, via `textMotion` (its
 * size stays the layer's scale; it has no keyframed zoom/opacity).
 *
 * Everything here takes plain keyframe lists / points rather than a `Layer`,
 * so captions can adopt the same helpers later without a rewrite.
 * @see docs/SHARED.md
 */

import type { LayerKeyframe } from './project'

/** A straight-line move: at (x0, y0) until `t0`, linear to (x1, y1) at `t1`,
 *  held there after. Times share whatever clock the caller uses (keyframe
 *  `tSec` is layer-local; the export works in absolute seconds). */
export interface LinearMotion {
  t0: number
  t1: number
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Shortest move the UI will create (seconds). */
export const MIN_MOTION_SEC = 0.1
/** Duration a new move starts with (seconds). */
export const DEFAULT_MOTION_SEC = 1
/** A new move's end point starts this fraction of the frame width to the side
 *  (right, or left when that would leave the frame), so both path dots are
 *  visible and grabbable. */
export const DEFAULT_MOTION_TRAVEL = 0.25

const EPS = 0.01
const sorted = (kfs: LayerKeyframe[]): LayerKeyframe[] => [...kfs].sort((a, b) => a.tSec - b.tSec)

/** Position on a linear motion at time `t` (same clock as the motion). */
export function motionPosAt(m: LinearMotion, t: number): { x: number; y: number } {
  // A zero-length move jumps at t0.
  if (m.t1 <= m.t0) return t < m.t0 ? { x: m.x0, y: m.y0 } : { x: m.x1, y: m.y1 }
  if (t <= m.t0) return { x: m.x0, y: m.y0 }
  if (t >= m.t1) return { x: m.x1, y: m.y1 }
  const f = (t - m.t0) / (m.t1 - m.t0)
  return { x: m.x0 + (m.x1 - m.x0) * f, y: m.y0 + (m.y1 - m.y0) * f }
}

/**
 * The move a TEXT layer's keyframes describe (layer-local times), or null when
 * it has none. Text burns through libass, where one event carries one straight
 * `\move`, so text follows the FIRST stretch between keyframes whose positions
 * differ and holds its end (preview and export both resolve through here, so
 * they agree). Keyframes that never move give a stationary "motion" at the
 * first keyframe's position — keyframes still override the base x/y.
 */
export function textMotion(kfs: LayerKeyframe[] | undefined): LinearMotion | null {
  if (!kfs || kfs.length === 0) return null
  const s = sorted(kfs)
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (Math.abs(b.x - a.x) > EPS || Math.abs(b.y - a.y) > EPS) {
      return { t0: a.tSec, t1: b.tSec, x0: a.x, y0: a.y, x1: b.x, y1: b.y }
    }
  }
  return { t0: s[0].tSec, t1: s[0].tSec, x0: s[0].x, y0: s[0].y, x1: s[0].x, y1: s[0].y }
}

/** A layer's keyframes ARE a simple move (the Motion section edits them):
 *  exactly two. */
export function isSimpleMotion(kfs: LayerKeyframe[] | undefined): kfs is [LayerKeyframe, LayerKeyframe] {
  return !!kfs && kfs.length === 2
}

/** The simple move, read from its two keyframes (layer-local times). */
export function simpleMotion(kfs: [LayerKeyframe, LayerKeyframe]): LinearMotion {
  const [a, b] = sorted(kfs)
  return { t0: a.tSec, t1: b.tSec, x0: a.x, y0: a.y, x1: b.x, y1: b.y }
}

/**
 * The two keyframes of a NEW move: it starts at `tLocal` (the playhead, clamped
 * into the layer) from where the layer is now, lasts `durSec` (clamped to the
 * layer's end), and ends `DEFAULT_MOTION_TRAVEL` of the frame width to the
 * side. `at` is the layer's current transform; `frame` the visible frame in
 * logical px.
 */
export function newMotionKeyframes(
  at: { x: number; y: number; scale: number; opacity?: number },
  tLocal: number,
  durSec: number,
  layerDurSec: number,
  frame: { x: number; w: number }
): [LayerKeyframe, LayerKeyframe] {
  const t0 = Math.max(0, Math.min(tLocal, Math.max(0, layerDurSec - MIN_MOTION_SEC)))
  const t1 = Math.min(layerDurSec, t0 + Math.max(MIN_MOTION_SEC, durSec))
  const travel = frame.w * DEFAULT_MOTION_TRAVEL
  const dx = at.x + travel <= frame.x + frame.w ? travel : -travel
  const op = at.opacity != null && at.opacity < 0.9995 ? { opacity: at.opacity } : {}
  return [
    { tSec: t0, x: at.x, y: at.y, scale: at.scale, ...op },
    { tSec: t1, x: at.x + dx, y: at.y, scale: at.scale, ...op }
  ]
}

/** Edit a simple move: any of its points, its start time or its duration
 *  (layer-local seconds, clamped into the layer). Each keyframe keeps its own
 *  scale/opacity. */
export function editSimpleMotion(
  kfs: [LayerKeyframe, LayerKeyframe],
  patch: Partial<{ x0: number; y0: number; x1: number; y1: number; t0: number; durSec: number }>,
  layerDurSec: number
): [LayerKeyframe, LayerKeyframe] {
  const [a, b] = sorted(kfs)
  const t0 = Math.max(0, Math.min(patch.t0 ?? a.tSec, Math.max(0, layerDurSec - MIN_MOTION_SEC)))
  const dur = Math.max(MIN_MOTION_SEC, patch.durSec ?? b.tSec - a.tSec)
  const t1 = Math.min(layerDurSec, t0 + dur)
  return [
    { ...a, tSec: t0, x: patch.x0 ?? a.x, y: patch.y0 ?? a.y },
    { ...b, tSec: t1, x: patch.x1 ?? b.x, y: patch.y1 ?? b.y }
  ]
}

/** Every keyframe moved by (dx, dy): the whole path, both ends, shifts. */
export function shiftKeyframes(kfs: LayerKeyframe[], dx: number, dy: number): LayerKeyframe[] {
  return kfs.map((k) => ({ ...k, x: k.x + dx, y: k.y + dy }))
}

/**
 * One burned event's slice of a motion, for a single ASS `\move`: the offset at
 * the event's start (`from`) and end (`to`), and the window inside the event
 * (seconds from its start) during which it travels. Before `t1` the event sits
 * at `from`, after `t2` at `to` — exactly `\move(…, t1, t2)` (verified —
 * FFMPEG-NOTES "Straight-line motion"). `static` when nothing moves in the
 * event (then `from` is the whole-event offset and a plain `\pos` will do).
 * `m` and the event share one clock.
 */
export function moveSlice(
  m: LinearMotion,
  eventStart: number,
  eventEnd: number
): { from: { x: number; y: number }; to: { x: number; y: number }; t1: number; t2: number; static: boolean } {
  const from = motionPosAt(m, eventStart)
  const to = motionPosAt(m, eventEnd)
  const s = Math.max(eventStart, Math.min(m.t0, eventEnd))
  const e = Math.max(eventStart, Math.min(m.t1, eventEnd))
  const still = Math.abs(to.x - from.x) < EPS && Math.abs(to.y - from.y) < EPS
  return { from, to, t1: s - eventStart, t2: e - eventStart, static: still }
}
