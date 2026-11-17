import { describe, expect, it } from 'vitest'
import type { MarkKeyframe } from '@shared/markAnim'
import {
  clampBetweenNeighbours,
  clampKeyframeX,
  DIAMOND_EXTENT_PX,
  keyframeAtPlayhead,
  keyframeX,
  pickedKeyframeIndex,
  visibleKeyframes,
  xToKeyframeSec
} from './markKeyframes'

const kf = (tSec: number): MarkKeyframe => ({
  tSec,
  dx: 0,
  dy: 0,
  scale: 1,
  rotationDeg: 0,
  opacity: 1,
  drawn: 1,
  color: '#fff',
  widthPx: 4,
  easing: 'linear'
})

describe('markKeyframes', () => {
  it('maps seconds to tile px and back', () => {
    expect(keyframeX(1.5, 48)).toBe(72)
    expect(xToKeyframeSec(72, 48)).toBe(1.5)
    expect(xToKeyframeSec(keyframeX(0.37, 100), 100)).toBeCloseTo(0.37, 12)
  })

  it('keeps only keyframes on the tile, with their indices', () => {
    const kfs = [kf(-0.5), kf(0), kf(2), kf(5), kf(5.01)]
    expect(visibleKeyframes(kfs, 5)).toEqual([
      { index: 1, tSec: 0 },
      { index: 2, tSec: 2 },
      { index: 3, tSec: 5 }
    ])
    expect(visibleKeyframes(undefined, 5)).toEqual([])
  })

  it('finds the keyframe at the playhead within 0.02 s, nearest first', () => {
    const kfs = [kf(1), kf(1.015), kf(3)]
    expect(keyframeAtPlayhead(kfs, 1.014)).toBe(1)
    expect(keyframeAtPlayhead(kfs, 3.019)).toBe(2)
    expect(keyframeAtPlayhead(kfs, 3.03)).toBe(-1)
    expect(keyframeAtPlayhead(undefined, 1)).toBe(-1)
    expect(keyframeAtPlayhead([], 1)).toBe(-1)
  })

  it('holds a dragged keyframe short of its neighbours', () => {
    const kfs = [kf(1), kf(2.5), kf(4)]
    expect(clampBetweenNeighbours(kfs, 0, 3.25)).toBeCloseTo(2.47, 10)
    expect(clampBetweenNeighbours(kfs, 1, 0.2)).toBeCloseTo(1.03, 10)
    expect(clampBetweenNeighbours(kfs, 1, 9)).toBeCloseTo(3.97, 10)
    expect(clampBetweenNeighbours(kfs, 1, 2)).toBe(2)
    expect(clampBetweenNeighbours(kfs, 0, -3)).toBe(-3)
    expect(clampBetweenNeighbours(kfs, 2, 99)).toBe(99)
  })

  it('clamps the drawn centre so the whole diamond stays on the tile', () => {
    const half = DIAMOND_EXTENT_PX / 2 + 1
    expect(clampKeyframeX(0, 200)).toBe(half)
    expect(clampKeyframeX(200, 200)).toBe(200 - half)
    expect(clampKeyframeX(80, 200)).toBe(80)
    expect(clampKeyframeX(-5, 200)).toBe(half)
    expect(clampKeyframeX(0, 200, 10)).toBe(6)
    expect(clampKeyframeX(300, 200, 10)).toBe(194)
    // A tile narrower than a diamond centres it.
    expect(clampKeyframeX(0, 8)).toBe(4)
  })

  it('resolves a picked keyframe and treats a stale pick as none', () => {
    const comp = {
      layers: [
        { id: 'G', content: { kind: 'graphics', marks: [{ id: 'M', keyframes: [kf(1), kf(2.5)] }, { id: 'N' }] } },
        { id: 'V', content: { kind: 'video' } }
      ]
    }
    expect(pickedKeyframeIndex(comp, { layerId: 'G', markId: 'M', tSec: 2.5 })).toBe(1)
    expect(pickedKeyframeIndex(comp, { layerId: 'G', markId: 'M', tSec: 1 })).toBe(0)
    expect(pickedKeyframeIndex(comp, { layerId: 'G', markId: 'M', tSec: 2 })).toBe(-1)
    expect(pickedKeyframeIndex(comp, { layerId: 'G', markId: 'N', tSec: 1 })).toBe(-1)
    expect(pickedKeyframeIndex(comp, { layerId: 'G', markId: 'X', tSec: 1 })).toBe(-1)
    expect(pickedKeyframeIndex(comp, { layerId: 'V', markId: 'M', tSec: 1 })).toBe(-1)
    expect(pickedKeyframeIndex(comp, { layerId: 'Z', markId: 'M', tSec: 1 })).toBe(-1)
    expect(pickedKeyframeIndex(comp, null)).toBe(-1)
  })
})
