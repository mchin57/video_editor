import { describe, expect, it } from 'vitest'
import { clamp, clamp01, clampInt } from './math'

describe('clamp', () => {
  it('limits to the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  it('lets the lower bound win when the bounds are inverted', () => {
    // A tile longer than the timeline: clamp(x, 0, total - len) must stay at 0.
    expect(clamp(3, 0, -2)).toBe(0)
  })

  it('clamp01 and clampInt', () => {
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(-0.5)).toBe(0)
    expect(clampInt(4.6, 1, 10)).toBe(5)
    expect(clampInt(10.6, 1, 10)).toBe(10)
    expect(clampInt(0.2, 1, 10)).toBe(1)
  })
})
