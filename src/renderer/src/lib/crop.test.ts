import { describe, it, expect } from 'vitest'
import { defaultCrop, clampCrop, resizeCrop, isFullFrame, OUTPUT_ASPECT } from './crop'

describe('defaultCrop', () => {
  it('a landscape frame gets a centered 9:16 vertical slice', () => {
    const c = defaultCrop(1920, 1080)
    expect(c.h).toBe(1080)
    expect(c.w).toBe(Math.round(1080 * OUTPUT_ASPECT)) // 608
    expect(c.y).toBe(0)
    expect(c.x).toBe(Math.round((1920 - c.w) / 2))
  })
  it('a 9:16 frame crops to the full frame', () => {
    const c = defaultCrop(1080, 1920)
    expect(c).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
  })
})

describe('clampCrop', () => {
  it('keeps the rect inside the source', () => {
    const c = clampCrop({ x: -50, y: 2000, w: 700, h: 1244 }, 1920, 1080)
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.y + c.h).toBeLessThanOrEqual(1080)
    expect(c.x + c.w).toBeLessThanOrEqual(1920)
  })
})

describe('resizeCrop', () => {
  it('keeps 9:16 and respects bounds', () => {
    const start = defaultCrop(1920, 1080)
    const bigger = resizeCrop(start, 5000, 1920, 1080)
    expect(bigger.w / bigger.h).toBeCloseTo(OUTPUT_ASPECT, 3)
    expect(bigger.x + bigger.w).toBeLessThanOrEqual(1920)
    expect(bigger.y + bigger.h).toBeLessThanOrEqual(1080)
  })
})

describe('isFullFrame', () => {
  it('null crop is full frame', () => {
    expect(isFullFrame(null, 1080, 1920)).toBe(true)
  })
  it('a sub-rect is not full frame', () => {
    expect(isFullFrame({ x: 100, y: 0, w: 600, h: 1067 }, 1920, 1080)).toBe(false)
  })
})
