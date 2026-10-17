import { describe, it, expect } from 'vitest'
import { MAX_SCALE_TICKS, niceTimeStep, scaleTicks, formatTick } from './timescale'

describe('niceTimeStep', () => {
  it('grows the step as zoom decreases', () => {
    expect(niceTimeStep(240)).toBe(0.5) // very zoomed in
    expect(niceTimeStep(48)).toBe(2) // default zoom: 2*48=96 ≥ 64
    expect(niceTimeStep(8)).toBe(10) // zoomed out
  })
})

describe('scaleTicks', () => {
  it('produces ticks from 0 through total', () => {
    expect(scaleTicks(10, 2)).toEqual([0, 2, 4, 6, 8, 10])
    expect(scaleTicks(0.9, 0.5)).toEqual([0, 0.5])
  })

  // Regression: End = 300000 froze the app and End = 1e9 threw
  // "RangeError: Invalid array length" and blanked the window.
  it('caps the tick count on an absurd span, keeping multiples of the step', () => {
    for (const total of [300000, 1e9]) {
      const ticks = scaleTicks(total, 2)
      expect(ticks.length).toBeLessThanOrEqual(MAX_SCALE_TICKS)
      expect(ticks.length).toBeGreaterThan(MAX_SCALE_TICKS / 2)
      expect(ticks[0]).toBe(0)
      expect(ticks.every((t) => t % 2 === 0)).toBe(true)
    }
    for (const total of [1e300, Number.MAX_VALUE])
      expect(scaleTicks(total, 2).length).toBeLessThanOrEqual(MAX_SCALE_TICKS)
    const big = scaleTicks(300000, 2)
    expect(big[big.length - 1]).toBeGreaterThan(300000 - (300000 / MAX_SCALE_TICKS) * 2)
  })

  it('survives a non-finite or zero total / step', () => {
    expect(scaleTicks(Number.POSITIVE_INFINITY, 2).length).toBeLessThanOrEqual(MAX_SCALE_TICKS)
    expect(scaleTicks(Number.NaN, 2)).toEqual([0])
    expect(scaleTicks(10, 0)).toEqual([0])
    expect(scaleTicks(10, Number.NaN)).toEqual([0])
  })
})

describe('formatTick', () => {
  it('m:ss for whole-second steps, m:ss.t for sub-second', () => {
    expect(formatTick(65, 5)).toBe('1:05')
    expect(formatTick(8, 1)).toBe('0:08')
    expect(formatTick(8.5, 0.5)).toBe('0:08.5')
  })
})
