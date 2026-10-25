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
    expect(
      frameTimes(
        100,
        Array.from({ length: 20 }, (_, i) => i)
      )
    ).toHaveLength(MAX_FRAMES)
  })
})

describe('frameTimes on a still (#11)', () => {
  it('gives one frame for a still, whatever count or times are asked', () => {
    expect(frameTimes(0, undefined, 8)).toEqual([0])
    expect(frameTimes(0)).toEqual([0])
    expect(frameTimes(0, [0, 1, 2])).toEqual([0])
  })

  it('never repeats a time when a very short clip clamps every slice to one moment', () => {
    // A JPEG probes as a nominal 0.04 s (ffprobe): shorter than the end guard.
    expect(frameTimes(0.04, undefined, 8)).toEqual([0])
  })
})
