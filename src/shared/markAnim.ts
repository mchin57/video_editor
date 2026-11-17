/**
 * One graphics mark's own animation: keyframed offset, size, rotation (about a
 * pivot), opacity, colours, thickness and how much is drawn, with easing per
 * keyframe. Pure — the preview and the export both draw a mark through
 * `markArtSvg` (shared/markPresets.ts, which adds the live presets), so a frame looks the same on both sides. The mark's keyframes
 * run on its LAYER's clock (seconds after the layer's start, like `atSec`); the
 * layer's own Motion keyframes still apply on top (`toCanvas`).
 */

import { lerpColor } from './color'
import {
  f2,
  LABEL_FONT_FAMILY,
  markBounds,
  markShapes,
  MARK_DEFAULTS,
  movedMark,
  shapeSvg,
  withMarkPoint,
  type GraphicMark,
  type Pt
} from './graphics'

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
export const EASINGS: { id: Easing; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in' },
  { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Ease in-out' }
]
export const DEFAULT_EASING: Easing = 'easeInOut'

/** A snapshot of a shape's animatable values. `tSec` is seconds after the LAYER's
 *  start — the same clock as `GraphicMark.atSec`. */
export interface MarkKeyframe {
  tSec: number
  /** Offset from where the shape is drawn, mark-space px. */
  dx: number
  dy: number
  /** 1 = as drawn. */
  scale: number
  /** Clockwise, about the pivot. */
  rotationDeg: number
  /** 0..1 */
  opacity: number
  /** 0..1 — how much of the shape is drawn. */
  drawn: number
  /** Border/stroke colour. */
  color: string
  /** Border/stroke thickness. */
  widthPx: number
  /** Fill colour; absent = the shape's own fill. Ignored when the shape has no fill. */
  fill?: string
  /** Easing of the stretch FROM this keyframe to the next. */
  easing: Easing
}

/** The resolved values at one instant. */
export interface MarkPose {
  dx: number
  dy: number
  scale: number
  rotationDeg: number
  opacity: number
  drawn: number
  color: string
  widthPx: number
  fill: string | null
}

/** How far through a stretch `f` (0..1) a value has got, under `e`. */
export function ease(e: Easing, f: number): number {
  switch (e) {
    case 'easeIn':
      return f * f * f
    case 'easeOut':
      return 1 - Math.pow(1 - f, 3)
    case 'easeInOut':
      return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2
    default:
      return f
  }
}

/** The pivot rotation/size act about: `pivot`, else the centre of the bounding box of the mark's points. */
export function markPivot(m: Pick<GraphicMark, 'points' | 'pivot'>): Pt {
  if (m.pivot) return m.pivot
  const xs = m.points.map((p) => p.x)
  const ys = m.points.map((p) => p.y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/** A mark's pose when it has no keyframes (its static rotation/size/opacity). */
export function staticPose(m: GraphicMark): MarkPose {
  return {
    dx: 0,
    dy: 0,
    scale: m.scale ?? 1,
    rotationDeg: m.rotationDeg ?? 0,
    opacity: m.opacity ?? 1,
    drawn: 1,
    color: m.color,
    widthPx: m.widthPx,
    fill: m.fill ?? null
  }
}

/** A keyframe's values as a pose (an absent fill = the mark's own; null without a base fill). */
function keyframePose(m: GraphicMark, k: MarkKeyframe): MarkPose {
  return {
    dx: k.dx,
    dy: k.dy,
    scale: k.scale,
    rotationDeg: k.rotationDeg,
    opacity: k.opacity,
    drawn: k.drawn,
    color: k.color,
    widthPx: k.widthPx,
    fill: m.fill ? (k.fill ?? m.fill) : null
  }
}

const mix = (a: number, b: number, f: number): number => a + (b - a) * f

/**
 * The mark's values `localSec` seconds after its layer's start: the static pose
 * without keyframes, else held at the first keyframe before it and the last
 * after it, and between two keyframes blended by the FIRST one's easing.
 */
export function markPoseAt(m: GraphicMark, localSec: number): MarkPose {
  const kfs = m.keyframes
  if (!kfs || kfs.length === 0) return staticPose(m)
  const sorted = kfs.every((k, i) => i === 0 || kfs[i - 1].tSec <= k.tSec)
    ? kfs
    : [...kfs].sort((a, b) => a.tSec - b.tSec)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (localSec <= first.tSec) return keyframePose(m, first)
  if (localSec >= last.tSec) return keyframePose(m, last)
  let i = 0
  while (i < sorted.length - 2 && localSec >= sorted[i + 1].tSec) i++
  const a = sorted[i]
  const b = sorted[i + 1]
  const span = b.tSec - a.tSec
  const f = span > 0 ? ease(a.easing, (localSec - a.tSec) / span) : 1
  const pa = keyframePose(m, a)
  const pb = keyframePose(m, b)
  return {
    dx: mix(pa.dx, pb.dx, f),
    dy: mix(pa.dy, pb.dy, f),
    scale: mix(pa.scale, pb.scale, f),
    rotationDeg: mix(pa.rotationDeg, pb.rotationDeg, f),
    opacity: mix(pa.opacity, pb.opacity, f),
    drawn: mix(pa.drawn, pb.drawn, f),
    color: lerpColor(pa.color, pb.color, f),
    widthPx: mix(pa.widthPx, pb.widthPx, f),
    fill: pa.fill && pb.fill ? lerpColor(pa.fill, pb.fill, f) : null
  }
}

const isIdentity = (p: MarkPose): boolean => p.dx === 0 && p.dy === 0 && p.scale === 1 && p.rotationDeg === 0

/** Whether a pose moves, turns or resizes the shape (false = drawn exactly where it is). */
export const isPosed = (p: MarkPose): boolean => !isIdentity(p)

/**
 * A pose as an SVG `transform`: offset (outermost), then rotate + scale about the
 * pivot. A point `p` lands at `posePoint(pose, pivot, p)`.
 */
export function poseTransform(pose: MarkPose, pivot: Pt): string {
  return (
    `translate(${f2(pose.dx)} ${f2(pose.dy)}) translate(${f2(pivot.x)} ${f2(pivot.y)}) ` +
    `rotate(${f2(pose.rotationDeg)}) scale(${f2(pose.scale)}) translate(${f2(-pivot.x)} ${f2(-pivot.y)})`
  )
}

/** Where a mark-space point is drawn under `pose` (what `poseTransform` does to it). */
export function posePoint(pose: MarkPose, pivot: Pt, p: Pt): Pt {
  const r = (pose.rotationDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const x = (p.x - pivot.x) * pose.scale
  const y = (p.y - pivot.y) * pose.scale
  return { x: pose.dx + pivot.x + x * cos - y * sin, y: pose.dy + pivot.y + x * sin + y * cos }
}

/** The mark-space point that is drawn at `p` under `pose` (the inverse of `posePoint`). */
export function unposePoint(pose: MarkPose, pivot: Pt, p: Pt): Pt {
  const r = (pose.rotationDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const s = pose.scale || 1
  const x = p.x - pose.dx - pivot.x
  const y = p.y - pose.dy - pivot.y
  return { x: pivot.x + (x * cos + y * sin) / s, y: pivot.y + (-x * sin + y * cos) / s }
}

/** The mark with the pose's colour, thickness and fill (what `markShapes` draws). */
export function posedMark(m: GraphicMark, pose: MarkPose): GraphicMark {
  return { ...m, color: pose.color, widthPx: pose.widthPx, fill: pose.fill }
}

/**
 * A mark's group at a pose: its shapes at `progress` (× the pose's `drawn`),
 * wrapped in the pose's transform and `revealOpacity` × the pose's opacity.
 * Attributes that would be the identity are left off.
 */
export function markPoseSvg(
  m: GraphicMark,
  pose: MarkPose,
  progress: number,
  revealOpacity: number,
  fontFamily: string = LABEL_FONT_FAMILY
): string {
  const shapes = markShapes(posedMark(m, pose), progress * pose.drawn)
  const opacity = revealOpacity * pose.opacity
  const attrs =
    (isIdentity(pose) ? '' : ` transform="${poseTransform(pose, markPivot(m))}"`) +
    (opacity === 1 ? '' : ` opacity="${Math.round(opacity * 1000) / 1000}"`)
  return `<g${attrs}>${shapes.map((s) => shapeSvg(s, fontFamily)).join('')}</g>`
}

/** Whether the mark actually changes over time: two or more keyframes whose values differ
 *  (a fill left to the shape's own counts as that fill). One keyframe is a constant pose. */
export function isMarkAnimated(m: GraphicMark): boolean {
  const kfs = m.keyframes
  if (!kfs || kfs.length < 2) return false
  const sig = (k: MarkKeyframe): string => {
    const p = keyframePose(m, k)
    return [p.dx, p.dy, p.scale, p.rotationDeg, p.opacity, p.drawn, p.color, p.widthPx, p.fill].join('|')
  }
  const first = sig(kfs[0])
  return kfs.some((k) => sig(k) !== first)
}

/** The box holding the drawn mark under `pose` (mark space). */
export function posedBounds(m: GraphicMark, pose: MarkPose): { x: number; y: number; w: number; h: number } {
  const b = markBounds(posedMark(m, pose))
  const pivot = markPivot(m)
  const cs = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h }
  ].map((c) => posePoint(pose, pivot, c))
  const xs = cs.map((c) => c.x)
  const ys = cs.map((c) => c.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The keyframe list with `kf` in it: any keyframe within `eps` seconds is replaced; sorted. */
export function upsertMarkKeyframe(kfs: MarkKeyframe[] | undefined, kf: MarkKeyframe, eps = 0.02): MarkKeyframe[] {
  const kept = (kfs ?? []).filter((k) => Math.abs(k.tSec - kf.tSec) > eps)
  return [...kept, kf].sort((a, b) => a.tSec - b.tSec)
}

/** A keyframe at `tSec` holding `pose` (a null fill leaves the keyframe's fill absent). */
export function keyframeFromPose(tSec: number, pose: MarkPose, easing: Easing): MarkKeyframe {
  return {
    tSec,
    dx: pose.dx,
    dy: pose.dy,
    scale: pose.scale,
    rotationDeg: pose.rotationDeg,
    opacity: pose.opacity,
    drawn: pose.drawn,
    color: pose.color,
    widthPx: pose.widthPx,
    easing,
    ...(pose.fill ? { fill: pose.fill } : {})
  }
}

/**
 * THE edit rule — every Inspector field and canvas drag goes through it. With
 * keyframes, the patch lands in a keyframe at `localSec` (an existing one there
 * keeps its easing; a new one starts from the pose at that moment). Without,
 * it writes the static base: colour, thickness, fill, rotation, size and opacity;
 * an offset moves the mark's points (and pivot) instead, and `drawn` has no static form.
 */
export function editPoseAt(m: GraphicMark, localSec: number, patch: Partial<MarkPose>): GraphicMark {
  if (m.keyframes && m.keyframes.length > 0) {
    const pose = { ...markPoseAt(m, localSec), ...patch }
    const at = nearestKeyframeIndex(m.keyframes, localSec)
    const existing = at >= 0 ? m.keyframes[at] : undefined
    // The nearest keyframe within reach is replaced in place at ITS time (so a drag doesn't
    // nudge it) and by index, so a neighbour a hair away is never swallowed.
    const kf = keyframeFromPose(existing ? existing.tSec : localSec, pose, existing?.easing ?? DEFAULT_EASING)
    const next = existing ? m.keyframes.map((k, j) => (j === at ? kf : k)) : [...m.keyframes, kf]
    return { ...m, keyframes: next.sort((a, b) => a.tSec - b.tSec) }
  }
  let next = m
  if (patch.dx || patch.dy) next = movedMark(next, patch.dx ?? 0, patch.dy ?? 0)
  const set: Partial<GraphicMark> = {}
  if (patch.color !== undefined) set.color = patch.color
  if (patch.widthPx !== undefined) set.widthPx = patch.widthPx
  if (patch.fill !== undefined) set.fill = patch.fill
  if (patch.rotationDeg !== undefined) set.rotationDeg = patch.rotationDeg
  if (patch.scale !== undefined) set.scale = patch.scale
  if (patch.opacity !== undefined) set.opacity = patch.opacity
  return { ...next, ...set }
}

/** How close two keyframes may sit (s) before they count as the same moment. */
const KEYFRAME_EPS = 0.02

/** Index of the keyframe nearest `tSec` within `KEYFRAME_EPS` (-1 if none). */
function nearestKeyframeIndex(kfs: MarkKeyframe[], tSec: number): number {
  let best = -1
  let bestD = Infinity
  kfs.forEach((k, i) => {
    const d = Math.abs(k.tSec - tSec)
    if (d <= KEYFRAME_EPS && d < bestD) {
      best = i
      bestD = d
    }
  })
  return best
}

/**
 * The mark with keyframe `i` moved to `tSec` (clamped to [0, maxSec] — the layer's
 * length), re-sorted. A move onto another keyframe (within 0.02 s) is refused: the mark
 * comes back unchanged.
 */
export function retimeMarkKeyframe(m: GraphicMark, i: number, tSec: number, maxSec: number): GraphicMark {
  const kfs = m.keyframes
  if (!kfs || i < 0 || i >= kfs.length) return m
  const t = Math.min(Math.max(0, maxSec), Math.max(0, tSec))
  if (kfs.some((k, j) => j !== i && Math.abs(k.tSec - t) <= KEYFRAME_EPS)) return m
  const next = kfs.map((k, j) => (j === i ? { ...k, tSec: t } : k))
  return { ...m, keyframes: next.sort((a, b) => a.tSec - b.tSec) }
}

/**
 * The mark with a keyframe at `localSec` capturing its pose there (the nearest one within
 * 0.02 s is replaced, keeping its time and easing). The first keyframe of a static mark
 * captures its static pose.
 */
export function addMarkKeyframeAt(m: GraphicMark, localSec: number): GraphicMark {
  const t = Math.max(0, localSec)
  if (!m.keyframes || m.keyframes.length === 0) {
    return { ...m, keyframes: [keyframeFromPose(t, markPoseAt(m, t), DEFAULT_EASING)] }
  }
  return editPoseAt(m, t, {})
}

/**
 * The mark with keyframe `i` removed. Removing the ONLY keyframe is `clearMarkKeyframes`
 * at `localSec`: the pose is baked into the static fields, not left to a stale base.
 */
export function removeMarkKeyframe(m: GraphicMark, i: number, localSec: number): GraphicMark {
  const kfs = m.keyframes
  if (!kfs || i < 0 || i >= kfs.length) return m
  if (kfs.length === 1) return clearMarkKeyframes(m, localSec)
  return { ...m, keyframes: kfs.filter((_, j) => j !== i) }
}

/**
 * The mark with its fill off. Any border (base or keyframe) too thin to see
 * (< 2 px) gets the default width, so nothing is left invisible.
 */
export function withFillOff(m: GraphicMark): GraphicMark {
  const fix = (w: number): number => (w < 2 ? MARK_DEFAULTS.widthPx : w)
  return {
    ...m,
    fill: null,
    widthPx: fix(m.widthPx),
    ...(m.keyframes ? { keyframes: m.keyframes.map((k) => ({ ...k, widthPx: fix(k.widthPx) })) } : {})
  }
}

/**
 * Point `i` dragged to where the pointer is DRAWN (`drawnPt`, mark space) at `localSec`.
 * A posed mark's pivot defaults to the points' box centre, which this drag would move
 * and swing the shape, so the pivot is pinned first. `pose` is what the mark is drawn at
 * (default: its keyframe pose; the preview passes the frame pose, presets included).
 */
export function withPosedMarkPoint(
  m: GraphicMark,
  i: number,
  drawnPt: Pt,
  localSec: number,
  pose: MarkPose = markPoseAt(m, localSec)
): GraphicMark {
  const pivot = markPivot(m)
  const pinned = (m.keyframes && m.keyframes.length > 0) || isPosed(pose) ? { ...m, pivot } : m
  return withMarkPoint(pinned, i, unposePoint(pose, pivot, drawnPt))
}

/**
 * The pivot moved so its handle lands at `drawnPt` (mark space) at `localSec` WITHOUT the
 * drawing moving. Static: the pivot is the pointer and the points translate to
 * compensate. Keyframed: the pivot is the mark-space point drawn there, and every
 * keyframe's offset compensates (d' = d − (I − R·S)(P' − P)), so each keyframe's own
 * drawing is unchanged (between keyframes the path shifts slightly where rotation differs).
 */
export function withPivotAt(m: GraphicMark, localSec: number, drawnPt: Pt): GraphicMark {
  const pose = markPoseAt(m, localSec)
  const P = markPivot(m)
  if (!m.keyframes || m.keyframes.length === 0) {
    const points = m.points.map((q) => unposePoint(pose, drawnPt, posePoint(pose, P, q)))
    return { ...m, points, pivot: { ...drawnPt } }
  }
  const P2 = unposePoint(pose, P, drawnPt)
  const ex = P2.x - P.x
  const ey = P2.y - P.y
  const keyframes = m.keyframes.map((k) => {
    const r = (k.rotationDeg * Math.PI) / 180
    const cos = Math.cos(r) * k.scale
    const sin = Math.sin(r) * k.scale
    return { ...k, dx: k.dx - (ex - (ex * cos - ey * sin)), dy: k.dy - (ey - (ex * sin + ey * cos)) }
  })
  return { ...m, pivot: P2, keyframes }
}

/**
 * The mark with its keyframes gone, left as it looks `localSec` after the
 * layer's start: that pose is written to the static fields and the offset moves
 * the points (and pivot).
 */
export function clearMarkKeyframes(m: GraphicMark, localSec: number): GraphicMark {
  if (!m.keyframes || m.keyframes.length === 0) return m
  const pose = markPoseAt(m, localSec)
  const { keyframes: _gone, ...rest } = m
  void _gone
  const moved = movedMark(rest, pose.dx, pose.dy)
  return {
    ...moved,
    color: pose.color,
    widthPx: pose.widthPx,
    ...(m.fill ? { fill: pose.fill } : {}),
    rotationDeg: pose.rotationDeg,
    scale: pose.scale,
    opacity: pose.opacity
  }
}
