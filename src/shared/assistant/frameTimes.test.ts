import { describe, expect, it } from 'vitest'
import { MAX_FRAMES, frameTimes } from './frameTimes'

describe('frameTimes', () => {
  it('samples the centres of equal slices when given a count', () => {
    expect(frameTimes(8, undefined, 4)).toEqual([1, 3, 5, 7])
  })

  it('defaults to 4 frames', () => {
    expect(frameTimes(8)).toHaveLength(4)
  })

  it('clamps explicit times into the clip and drops duplicates', () => {
    expect(frameTimes(10, [-1, 0, 3, 3, 99])).toEqual([0, 3, 9.95])
  })

  it('never returns more than MAX_FRAMES', () => {
    expect(frameTimes(100, undefined, 50)).toHaveLength(MAX_FRAMES)
    expect(frameTimes(100, Array.from({ length: 20 }, (_, i) => i))).toHaveLength(MAX_FRAMES)
  })
})
