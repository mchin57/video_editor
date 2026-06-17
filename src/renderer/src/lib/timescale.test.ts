import { describe, it, expect } from 'vitest'
import { niceTimeStep, scaleTicks, formatTick } from './timescale'

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
  })
})

describe('formatTick', () => {
  it('m:ss for whole-second steps, m:ss.t for sub-second', () => {
    expect(formatTick(65, 5)).toBe('1:05')
    expect(formatTick(8, 1)).toBe('0:08')
    expect(formatTick(8.5, 0.5)).toBe('0:08.5')
  })
})
