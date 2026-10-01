import { describe, expect, it } from 'vitest'
import { layerTransformAt } from './layers'
import type { Layer, LayerKeyframe } from './project'
import {
  editSimpleMotion,
  isSimpleMotion,
  motionPosAt,
  moveSlice,
  newMotionKeyframes,
  shiftKeyframes,
  simpleMotion,
  textMotion
} from './motion'

const kf = (tSec: number, x: number, y: number, scale = 1): LayerKeyframe => ({ tSec, x, y, scale })
const m = { t0: 1, t1: 3, x0: 0, y0: 0, x1: 100, y1: -50 }

describe('motionPosAt', () => {
  it('holds before, lerps between, holds after', () => {
    expect(motionPosAt(m, 0)).toEqual({ x: 0, y: 0 })
    expect(motionPosAt(m, 2)).toEqual({ x: 50, y: -25 })
    expect(motionPosAt(m, 9)).toEqual({ x: 100, y: -50 })
  })
  it('agrees with layerTransformAt for a two-keyframe layer (one motion model)', () => {
    const layer = { startSec: 10, x: 0, y: 0, scale: 1, keyframes: [kf(1, 0, 0), kf(3, 100, -50)] } as unknown as Layer
    for (const t of [0, 1.5, 2.2, 3, 4]) {
      const a = layerTransformAt(layer, 10 + t)
      const b = motionPosAt(simpleMotion(layer.keyframes as [LayerKeyframe, LayerKeyframe]), t)
      expect(b.x).toBeCloseTo(a.x, 9)
      expect(b.y).toBeCloseTo(a.y, 9)
    }
  })
})

describe('textMotion', () => {
  it('is null without keyframes', () => {
    expect(textMotion(undefined)).toBeNull()
    expect(textMotion([])).toBeNull()
  })
  it('reads the first moving stretch, whatever the order', () => {
    expect(textMotion([kf(3, 100, -50), kf(1, 0, 0)])).toEqual(m)
  })
  it('skips leading and trailing holds (a split leaves a seam keyframe)', () => {
    expect(textMotion([kf(0, 0, 0), kf(1, 0, 0), kf(3, 100, -50), kf(4, 100, -50)])).toEqual(m)
  })
  it('keyframes that never move pin the text in place', () => {
    expect(textMotion([kf(0, 5, 6), kf(2, 5, 6)])).toMatchObject({ x0: 5, y0: 6, x1: 5, y1: 6 })
  })
})

describe('isSimpleMotion', () => {
  it('is exactly two keyframes', () => {
    expect(isSimpleMotion(undefined)).toBe(false)
    expect(isSimpleMotion([kf(0, 0, 0)])).toBe(false)
    expect(isSimpleMotion([kf(0, 0, 0), kf(1, 1, 1)])).toBe(true)
    expect(isSimpleMotion([kf(0, 0, 0), kf(1, 1, 1), kf(2, 2, 2)])).toBe(false)
  })
})

describe('newMotionKeyframes', () => {
  const frame = { x: 0, w: 1080 }
  it('starts at the playhead from where the layer is, and travels to the side', () => {
    const [a, b] = newMotionKeyframes({ x: 300, y: 900, scale: 0.5 }, 2, 1, 6, frame)
    expect(a).toEqual({ tSec: 2, x: 300, y: 900, scale: 0.5 })
    expect(b).toEqual({ tSec: 3, x: 570, y: 900, scale: 0.5 })
  })
  it('travels left when right would leave the frame', () => {
    const [, b] = newMotionKeyframes({ x: 900, y: 900, scale: 1 }, 0, 1, 6, frame)
    expect(b.x).toBe(630)
  })
  it('clamps into the layer (a playhead past the end, a duration past the end)', () => {
    const [a, b] = newMotionKeyframes({ x: 0, y: 0, scale: 1 }, 9, 5, 4, frame)
    expect(a.tSec).toBeCloseTo(3.9, 9)
    expect(b.tSec).toBe(4)
    const [c, d] = newMotionKeyframes({ x: 0, y: 0, scale: 1 }, 1, 5, 4, frame)
    expect(c.tSec).toBe(1)
    expect(d.tSec).toBe(4)
  })
  it('keeps a partial opacity on both keyframes, and stores full opacity as absence', () => {
    const [a, b] = newMotionKeyframes({ x: 0, y: 0, scale: 1, opacity: 0.4 }, 0, 1, 4, frame)
    expect(a.opacity).toBe(0.4)
    expect(b.opacity).toBe(0.4)
    expect('opacity' in newMotionKeyframes({ x: 0, y: 0, scale: 1, opacity: 1 }, 0, 1, 4, frame)[0]).toBe(false)
  })
})

describe('editSimpleMotion', () => {
  const two: [LayerKeyframe, LayerKeyframe] = [kf(1, 0, 0, 0.5), kf(3, 100, -50, 0.7)]
  it('moves one end without touching the other', () => {
    const [a, b] = editSimpleMotion(two, { x1: 200 }, 6)
    expect(a).toEqual(two[0])
    expect(b).toEqual({ ...two[1], x: 200 })
  })
  it('retimes: a new start keeps the duration; a new duration keeps the start', () => {
    expect(editSimpleMotion(two, { t0: 2 }, 6).map((k) => k.tSec)).toEqual([2, 4])
    expect(editSimpleMotion(two, { durSec: 0.5 }, 6).map((k) => k.tSec)).toEqual([1, 1.5])
  })
  it('clamps into the layer and to the minimum duration', () => {
    expect(editSimpleMotion(two, { durSec: 99 }, 6).map((k) => k.tSec)).toEqual([1, 6])
    expect(editSimpleMotion(two, { durSec: 0 }, 6)[1].tSec).toBeCloseTo(1.1, 9)
  })
})

describe('shiftKeyframes', () => {
  it('moves the whole path', () => {
    expect(shiftKeyframes([kf(0, 1, 2), kf(1, 3, 4)], 10, -10)).toEqual([kf(0, 11, -8), kf(1, 13, -6)])
  })
})

describe('moveSlice', () => {
  it('covers an event wholly inside the move', () => {
    const s = moveSlice(m, 1.5, 2.5)
    expect(s).toEqual({ from: { x: 25, y: -12.5 }, to: { x: 75, y: -37.5 }, t1: 0, t2: 1, static: false })
  })
  it('windows a move that starts and ends inside a longer event', () => {
    const s = moveSlice(m, 0, 5)
    expect(s).toEqual({ from: { x: 0, y: 0 }, to: { x: 100, y: -50 }, t1: 1, t2: 3, static: false })
  })
  it('is static before and after the move', () => {
    expect(moveSlice(m, 0, 0.5)).toMatchObject({ from: { x: 0, y: 0 }, static: true })
    expect(moveSlice(m, 3.5, 4)).toMatchObject({ from: { x: 100, y: -50 }, static: true })
  })
})
