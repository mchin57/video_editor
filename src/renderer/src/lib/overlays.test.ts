import { describe, it, expect } from 'vitest'
import {
  overlaysAtTime,
  hookCovered,
  makeOverlay,
  HOOK_WINDOW_SEC,
  imageOverlaysAtTime,
  makeImageOverlay
} from './overlays'

describe('overlaysAtTime', () => {
  const a = makeOverlay('a', 0, 2)
  const b = makeOverlay('b', 1.5, 5)
  it('returns overlays whose window contains t', () => {
    expect(overlaysAtTime([a, b], 1).map((o) => o.id)).toEqual(['a'])
    expect(overlaysAtTime([a, b], 1.7).map((o) => o.id)).toEqual(['a', 'b'])
    expect(overlaysAtTime([a, b], 4).map((o) => o.id)).toEqual(['b'])
    expect(overlaysAtTime([a, b], 9)).toEqual([])
  })
  it('end is exclusive', () => {
    expect(overlaysAtTime([a], 2)).toEqual([])
  })
})

describe('hookCovered', () => {
  it('true when a non-empty overlay starts within the first 3s', () => {
    expect(hookCovered([makeOverlay('a', 0, 2)])).toBe(true)
    expect(hookCovered([makeOverlay('a', HOOK_WINDOW_SEC - 0.1, 6)])).toBe(true)
  })
  it('false when the first overlay starts at/after 3s', () => {
    expect(hookCovered([makeOverlay('a', 3, 6)])).toBe(false)
  })
  it('false for empty text', () => {
    const o = { ...makeOverlay('a', 0, 3), text: '   ' }
    expect(hookCovered([o])).toBe(false)
  })
  it('false when there are no overlays', () => {
    expect(hookCovered([])).toBe(false)
  })
})

describe('makeImageOverlay', () => {
  it('keeps the source aspect, centers it, full opacity', () => {
    const o = makeImageOverlay('i', 'm1', 1, 4, 2) // 2:1 source
    expect(o.w / o.h).toBeCloseTo(2, 5)
    expect(o.anchor).toBe('center')
    expect(o.x).toBe(540)
    expect(o.opacity).toBe(1)
    expect(o.mediaId).toBe('m1')
  })
  it('guards a degenerate aspect', () => {
    const o = makeImageOverlay('i', 'm1', 0, 3, 0)
    expect(Number.isFinite(o.h)).toBe(true)
    expect(o.h).toBeGreaterThan(0)
  })
})

describe('imageOverlaysAtTime', () => {
  const a = makeImageOverlay('a', 'm', 0, 2, 1)
  const b = makeImageOverlay('b', 'm', 1.5, 5, 1)
  it('filters by time window, end exclusive', () => {
    expect(imageOverlaysAtTime([a, b], 1).map((o) => o.id)).toEqual(['a'])
    expect(imageOverlaysAtTime([a, b], 1.7).map((o) => o.id)).toEqual(['a', 'b'])
    expect(imageOverlaysAtTime([a, b], 2).map((o) => o.id)).toEqual(['b'])
  })
})
