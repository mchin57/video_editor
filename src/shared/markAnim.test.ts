import { describe, expect, it } from 'vitest'
import { lerpColor } from './color'
import { markBounds, MARK_DEFAULTS, newMark, type GraphicMark } from './graphics'
import {
  DEFAULT_EASING,
  EASINGS,
  ease,
  editPoseAt,
  isMarkAnimated,
  keyframeFromPose,
  markPivot,
  markPoseAt,
  posePoint,
  posedBounds,
  posedMark,
  poseTransform,
  staticPose,
  unposePoint,
  addMarkKeyframeAt,
  clearMarkKeyframes,
  removeMarkKeyframe,
  retimeMarkKeyframe,
  withFillOff,
  withPivotAt,
  withPosedMarkPoint,
  upsertMarkKeyframe,
  type MarkKeyframe,
  type MarkPose
} from './markAnim'

const rect = (extra: Partial<GraphicMark> = {}): GraphicMark => ({
  ...newMark('rect', 'R', { x: 100, y: 200 }, { x: 300, y: 400 }, 0),
  ...extra
})
const kf = (tSec: number, extra: Partial<MarkKeyframe> = {}): MarkKeyframe => ({
  tSec,
  dx: 0,
  dy: 0,
  scale: 1,
  rotationDeg: 0,
  opacity: 1,
  drawn: 1,
  color: '#ffd60a',
  widthPx: 8,
  easing: 'linear',
  ...extra
})

describe('ease', () => {
  it('has the right endpoints and midpoints', () => {
    for (const { id } of EASINGS) {
      expect(ease(id, 0)).toBeCloseTo(0)
      expect(ease(id, 1)).toBeCloseTo(1)
    }
    expect(ease('linear', 0.25)).toBeCloseTo(0.25)
    expect(ease('easeIn', 0.5)).toBeCloseTo(0.125)
    expect(ease('easeOut', 0.5)).toBeCloseTo(0.875)
    expect(ease('easeInOut', 0.25)).toBeCloseTo(0.0625)
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5)
    expect(ease('easeInOut', 0.75)).toBeCloseTo(0.9375)
    expect(DEFAULT_EASING).toBe('easeInOut')
  })
})

describe('lerpColor', () => {
  it('blends per channel, and alpha too', () => {
    expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(lerpColor('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(lerpColor('#ff0000', '#0000ff', 1)).toBe('#0000ff')
    // A missing alpha is ff; an opaque result stays six digits, otherwise eight.
    expect(lerpColor('#ff000000', '#ff0000', 0.5)).toBe('#ff000080')
    expect(lerpColor('#FF0000FF', '#00FF00', 1)).toBe('#00ff00')
  })
})

describe('markPivot / staticPose', () => {
  it('pivots on the points’ box centre unless set', () => {
    expect(markPivot(rect())).toEqual({ x: 200, y: 300 })
    expect(markPivot(rect({ pivot: { x: 1, y: 2 } }))).toEqual({ x: 1, y: 2 })
  })
  it('reads the static base fields', () => {
    expect(staticPose(rect())).toMatchObject({
      dx: 0,
      dy: 0,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      drawn: 1,
      fill: null
    })
    expect(staticPose(rect({ rotationDeg: 30, scale: 2, opacity: 0.5, fill: '#112233' }))).toMatchObject({
      scale: 2,
      rotationDeg: 30,
      opacity: 0.5,
      fill: '#112233'
    })
  })
})

describe('markPoseAt', () => {
  it('is the static pose without keyframes', () => {
    const m = rect({ rotationDeg: 10 })
    expect(markPoseAt(m, 5)).toEqual(staticPose(m))
  })
  it('holds before the first and after the last keyframe; one keyframe is constant', () => {
    const m = rect({ keyframes: [kf(1, { dx: 10 }), kf(3, { dx: 50 })] })
    expect(markPoseAt(m, 0).dx).toBe(10)
    expect(markPoseAt(m, 9).dx).toBe(50)
    expect(markPoseAt(rect({ keyframes: [kf(1, { dx: 7 })] }), 0).dx).toBe(7)
  })
  it('eases between keyframes by the first one’s easing, colours and numbers alike', () => {
    const m = rect({
      keyframes: [
        kf(0, { dx: 0, color: '#000000', scale: 1, easing: 'easeIn' }),
        kf(2, { dx: 100, color: '#ffffff', scale: 3 })
      ]
    })
    const p = markPoseAt(m, 1)
    expect(p.dx).toBeCloseTo(12.5)
    expect(p.scale).toBeCloseTo(1 + 2 * 0.125)
    expect(p.color).toBe(lerpColor('#000000', '#ffffff', 0.125))
  })
  it('lerps rotation numerically (0 to 720 spins twice)', () => {
    const m = rect({ keyframes: [kf(0, { rotationDeg: 0 }), kf(1, { rotationDeg: 720 })] })
    expect(markPoseAt(m, 0.25).rotationDeg).toBeCloseTo(180)
    expect(markPoseAt(m, 1).rotationDeg).toBe(720)
  })
  it('resolves an absent fill to the base fill, and is null without a base fill', () => {
    const filled = rect({ fill: '#ff0000', keyframes: [kf(0), kf(1, { fill: '#0000ff' })] })
    expect(markPoseAt(filled, 0).fill).toBe('#ff0000')
    expect(markPoseAt(filled, 0.5).fill).toBe('#800080')
    const bare = rect({ keyframes: [kf(0, { fill: '#00ff00' }), kf(1)] })
    expect(markPoseAt(bare, 0.5).fill).toBeNull()
  })
})

describe('poseTransform / posePoint / unposePoint', () => {
  const pose: MarkPose = { ...staticPose(rect()), dx: 10, dy: -5, scale: 1.5, rotationDeg: 90 }
  const pivot = { x: 200, y: 300 }
  it('formats the SVG transform', () => {
    expect(poseTransform(pose, pivot)).toBe(
      'translate(10 -5) translate(200 300) rotate(90) scale(1.5) translate(-200 -300)'
    )
  })
  it('maps a point the way the transform does (clockwise, y down)', () => {
    const q = posePoint({ ...pose, dx: 0, dy: 0, scale: 1 }, pivot, { x: 300, y: 300 })
    expect(q.x).toBeCloseTo(200)
    expect(q.y).toBeCloseTo(400)
  })
  it('round-trips with rotation and scale', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 123, y: 456 },
      { x: -50, y: 900 }
    ]) {
      const back = unposePoint(pose, pivot, posePoint(pose, pivot, p))
      expect(back.x).toBeCloseTo(p.x)
      expect(back.y).toBeCloseTo(p.y)
    }
  })
})

describe('isMarkAnimated', () => {
  it('needs two keyframes that differ', () => {
    expect(isMarkAnimated(rect())).toBe(false)
    expect(isMarkAnimated(rect({ keyframes: [kf(0)] }))).toBe(false)
    expect(isMarkAnimated(rect({ keyframes: [kf(0), kf(1, { easing: 'easeIn' })] }))).toBe(false)
    expect(isMarkAnimated(rect({ keyframes: [kf(0), kf(1, { dx: 5 })] }))).toBe(true)
    expect(isMarkAnimated(rect({ keyframes: [kf(0), kf(1, { color: '#000000' })] }))).toBe(true)
  })
})

describe('posedBounds', () => {
  it('holds the transformed mark', () => {
    const m = rect()
    const pose: MarkPose = { ...staticPose(m), dx: 50, rotationDeg: 90 }
    const b = posedBounds(m, pose)
    const own = markBounds(posedMark(m, pose))
    // A quarter turn swaps the box's width and height about its centre, shifted by dx.
    expect(b.w).toBeCloseTo(own.h)
    expect(b.h).toBeCloseTo(own.w)
    expect(b.x + b.w / 2).toBeCloseTo(own.x + own.w / 2 + 50)
    expect(b.y + b.h / 2).toBeCloseTo(own.y + own.h / 2)
  })
})

describe('upsertMarkKeyframe / keyframeFromPose', () => {
  it('replaces within eps and keeps sorted', () => {
    const out = upsertMarkKeyframe([kf(2), kf(0)], kf(0.01, { dx: 9 }))
    expect(out.map((k) => k.tSec)).toEqual([0.01, 2])
    expect(upsertMarkKeyframe(out, kf(1)).map((k) => k.tSec)).toEqual([0.01, 1, 2])
  })
  it('captures a pose, fill only when set', () => {
    const p = staticPose(rect())
    expect(keyframeFromPose(1, p, 'easeOut')).toMatchObject({ tSec: 1, easing: 'easeOut' })
    expect('fill' in keyframeFromPose(1, p, 'easeOut')).toBe(false)
    expect(keyframeFromPose(1, { ...p, fill: '#123456' }, 'linear').fill).toBe('#123456')
  })
})

describe('editPoseAt', () => {
  it('with keyframes upserts a keyframe at the moment, from the pose there', () => {
    const m = rect({ keyframes: [kf(0), kf(2, { dx: 100 })] })
    const e = editPoseAt(m, 1, { rotationDeg: 45 })
    expect(e.keyframes).toHaveLength(3)
    const mid = e.keyframes![1]
    expect(mid.tSec).toBe(1)
    expect(mid.rotationDeg).toBe(45)
    expect(mid.dx).toBeCloseTo(50)
    expect(mid.easing).toBe(DEFAULT_EASING)
    expect(e.points).toEqual(m.points)
    expect(e.color).toBe(m.color)
  })
  it('keeps an existing keyframe’s easing and time', () => {
    const m = rect({ keyframes: [kf(0, { easing: 'easeOut' }), kf(2, { dx: 100 })] })
    const e = editPoseAt(m, 0.01, { dx: 5 })
    expect(e.keyframes).toHaveLength(2)
    expect(e.keyframes![0]).toMatchObject({ tSec: 0, dx: 5, easing: 'easeOut' })
  })
  it('writes colour to the keyframe, not the base, when keyframed', () => {
    const m = rect({ keyframes: [kf(0), kf(1, { dx: 1 })] })
    const e = editPoseAt(m, 1, { color: '#123456' })
    expect(e.color).toBe(m.color)
    expect(e.keyframes![1].color).toBe('#123456')
  })
  it('without keyframes writes the static base fields', () => {
    const e = editPoseAt(rect(), 1, {
      color: '#123456',
      widthPx: 3,
      fill: '#abcdef',
      rotationDeg: 20,
      scale: 2,
      opacity: 0.4,
      drawn: 0.2
    })
    expect(e).toMatchObject({ color: '#123456', widthPx: 3, fill: '#abcdef', rotationDeg: 20, scale: 2, opacity: 0.4 })
    expect(e.keyframes).toBeUndefined()
  })
  it('without keyframes a dx/dy moves the points and pivot', () => {
    const m = rect({ pivot: { x: 1, y: 1 } })
    const e = editPoseAt(m, 0, { dx: 10, dy: -4 })
    expect(e.points[0]).toEqual({ x: 110, y: 196 })
    expect(e.pivot).toEqual({ x: 11, y: -3 })
  })
})

describe('retimeMarkKeyframe / clearMarkKeyframes', () => {
  it('re-sorts a retimed keyframe and clamps it to 0', () => {
    const m = rect({ keyframes: [kf(0, { dx: 1 }), kf(1, { dx: 2 })] })
    expect(retimeMarkKeyframe(m, 0, 3, 10).keyframes!.map((k) => k.dx)).toEqual([2, 1])
    expect(retimeMarkKeyframe(m, 1, -4, 10).keyframes![0].tSec).toBe(0)
    expect(retimeMarkKeyframe(m, 9, 1, 10)).toBe(m)
    expect(retimeMarkKeyframe(m, 0, 99, 5).keyframes!.map((k) => k.tSec)).toEqual([1, 5])
  })
  it('refuses a retime onto another keyframe', () => {
    const m = rect({ keyframes: [kf(0), kf(1)] })
    expect(retimeMarkKeyframe(m, 0, 1.01, 10)).toBe(m)
    expect(retimeMarkKeyframe(m, 0, 1.1, 10).keyframes!.map((k) => k.tSec)).toEqual([1, 1.1])
  })
  it('leaves the shape at its pose at the playhead', () => {
    const m = rect({ keyframes: [kf(0), kf(2, { dx: 100, rotationDeg: 90, scale: 2, color: '#000000' })] })
    const c = clearMarkKeyframes(m, 1)
    const want = markPoseAt(m, 1)
    expect(c.keyframes).toBeUndefined()
    expect(c.points[0].x).toBeCloseTo(100 + want.dx)
    expect(c).toMatchObject({ rotationDeg: want.rotationDeg, scale: want.scale, color: want.color })
    expect(markPoseAt(c, 5)).toMatchObject({ dx: 0, rotationDeg: want.rotationDeg })
  })
})

describe('editPoseAt near-duplicate keyframes', () => {
  it('replaces the NEAREST keyframe within reach and leaves a neighbour 0.01 s away alone', () => {
    const m = rect({ keyframes: [kf(1, { dx: 1 }), kf(1.01, { dx: 2, easing: 'easeOut' }), kf(3, { dx: 3 })] })
    const e = editPoseAt(m, 1.012, { rotationDeg: 30 })
    expect(e.keyframes).toHaveLength(3)
    expect(e.keyframes![0]).toEqual(m.keyframes![0])
    expect(e.keyframes![1]).toMatchObject({ tSec: 1.01, rotationDeg: 30, easing: 'easeOut' })
    expect(e.keyframes![2]).toEqual(m.keyframes![2])
  })
})

describe('addMarkKeyframeAt', () => {
  it('captures the static pose as the first keyframe', () => {
    const e = addMarkKeyframeAt(rect({ rotationDeg: 20 }), 1.5)
    expect(e.keyframes).toHaveLength(1)
    expect(e.keyframes![0]).toMatchObject({ tSec: 1.5, rotationDeg: 20, easing: DEFAULT_EASING })
  })
  it('adds in order, and replaces one within 0.02 s keeping its easing', () => {
    const m = rect({ keyframes: [kf(0), kf(2, { dx: 100, easing: 'easeOut' })] })
    const added = addMarkKeyframeAt(m, 1)
    expect(added.keyframes!.map((k) => k.tSec)).toEqual([0, 1, 2])
    expect(added.keyframes![1].dx).toBeCloseTo(50)
    const same = addMarkKeyframeAt(m, 1.99)
    expect(same.keyframes).toHaveLength(2)
    expect(same.keyframes![1]).toMatchObject({ tSec: 2, easing: 'easeOut' })
  })
})

describe('removeMarkKeyframe', () => {
  it('drops one of several', () => {
    const m = rect({ keyframes: [kf(0), kf(1, { dx: 5 })] })
    expect(removeMarkKeyframe(m, 0, 0).keyframes).toEqual([m.keyframes![1]])
    expect(removeMarkKeyframe(m, 7, 0)).toBe(m)
  })
  it('removing the last keyframe bakes the pose into the static fields', () => {
    const m = rect({ rotationDeg: 5, keyframes: [kf(1, { dx: 40, rotationDeg: 90, scale: 2, color: '#000000' })] })
    const e = removeMarkKeyframe(m, 0, 0.5)
    expect(e.keyframes).toBeUndefined()
    expect(e).toMatchObject({ rotationDeg: 90, scale: 2, color: '#000000' })
    expect(e.points[0].x).toBeCloseTo(140)
  })
})

describe('withFillOff', () => {
  it('turns the fill off and thickens any border under 2px, base and keyframes', () => {
    const m = rect({ fill: '#ff000066', widthPx: 0, keyframes: [kf(0, { widthPx: 0 }), kf(1, { widthPx: 5 })] })
    const e = withFillOff(m)
    expect(e.fill).toBeNull()
    expect(e.widthPx).toBe(MARK_DEFAULTS.widthPx)
    expect(e.keyframes!.map((k) => k.widthPx)).toEqual([MARK_DEFAULTS.widthPx, 5])
  })
  it('leaves a mark without keyframes keyless', () => {
    expect('keyframes' in withFillOff(rect({ fill: '#ff000066' }))).toBe(false)
  })
})

describe('withPosedMarkPoint', () => {
  it('pins the pivot so the other points stay put and the dragged one follows the pointer', () => {
    const m = rect({ rotationDeg: 45, scale: 1.5 })
    const pose = markPoseAt(m, 0)
    const pivot = markPivot(m)
    const want = { x: 50, y: 120 }
    const e = withPosedMarkPoint(m, 0, want, 0)
    const pose2 = markPoseAt(e, 0)
    const p0 = posePoint(pose2, markPivot(e), e.points[0])
    expect(p0.x).toBeCloseTo(want.x)
    expect(p0.y).toBeCloseTo(want.y)
    const p1 = posePoint(pose2, markPivot(e), e.points[1])
    const q1 = posePoint(pose, pivot, m.points[1])
    expect(p1.x).toBeCloseTo(q1.x)
    expect(p1.y).toBeCloseTo(q1.y)
    expect(e.pivot).toEqual(pivot)
  })
  it('leaves an unposed mark’s pivot alone', () => {
    expect(withPosedMarkPoint(rect(), 0, { x: 10, y: 10 }, 0).pivot).toBeUndefined()
  })
})

describe('withPivotAt', () => {
  const drawn = (m: GraphicMark, t: number): { x: number; y: number }[] =>
    m.points.map((q) => posePoint(markPoseAt(m, t), markPivot(m), q))
  it('static rotated+scaled: handle under the pointer, drawing unchanged at any time', () => {
    const m = rect({ rotationDeg: 33, scale: 1.7 })
    const target = { x: 260, y: 150 }
    const e = withPivotAt(m, 0, target)
    const h = posePoint(markPoseAt(e, 0), markPivot(e), markPivot(e))
    expect(h.x).toBeCloseTo(target.x)
    expect(h.y).toBeCloseTo(target.y)
    for (const t of [0, 4]) {
      drawn(m, t).forEach((p, i) => {
        expect(drawn(e, t)[i].x).toBeCloseTo(p.x)
        expect(drawn(e, t)[i].y).toBeCloseTo(p.y)
      })
    }
    expect(e.keyframes).toBeUndefined()
  })
  it('keyframed: handle under the pointer and every keyframe’s drawing unchanged', () => {
    const m = rect({
      keyframes: [kf(0, { rotationDeg: 20, scale: 1.2, dx: 5 }), kf(2, { rotationDeg: 100, scale: 0.6, dy: -30 })]
    })
    const target = { x: 320, y: 250 }
    for (const at of [0, 2]) {
      const e = withPivotAt(m, at, target)
      const h = posePoint(markPoseAt(e, at), markPivot(e), markPivot(e))
      expect(h.x).toBeCloseTo(target.x)
      expect(h.y).toBeCloseTo(target.y)
      expect(e.points).toEqual(m.points)
      for (const t of [0, 2]) {
        drawn(m, t).forEach((p, i) => {
          expect(drawn(e, t)[i].x).toBeCloseTo(p.x)
          expect(drawn(e, t)[i].y).toBeCloseTo(p.y)
        })
      }
    }
  })
})
