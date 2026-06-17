import { describe, it, expect } from 'vitest'
import { buildTimelineCaptions, type CaptionSource } from './captions'
import type { CaptionWord } from '@shared/project'

const src = (mediaId: string, startSec: number, inSec: number, outSec: number): CaptionSource => ({
  mediaId,
  startSec,
  inSec,
  outSec
})
const w = (text: string, startSec: number, endSec: number): CaptionWord => ({ text, startSec, endSec })

describe('buildTimelineCaptions', () => {
  it('groups words into short segments and breaks on sentence end', () => {
    const words = [w('look', 0, 0.4), w('at', 0.4, 0.6), w('the', 0.6, 0.8), w('sunset.', 0.8, 1.2), w('Wow', 1.3, 1.7)]
    const segs = buildTimelineCaptions([src('m', 0, 0, 5)], { m: words }, { maxWords: 6, maxChars: 100 })
    expect(segs.map((s) => s.text)).toEqual(['look at the sunset.', 'Wow'])
  })

  it('maps source-time words into timeline time, respecting the source position/trim', () => {
    // source plays media [2,4) at timeline start 0 → a word at source 2.5 → timeline 0.5
    const segs = buildTimelineCaptions([src('m', 0, 2, 4)], { m: [w('hello', 2.5, 2.9)] })
    expect(segs).toHaveLength(1)
    expect(segs[0].startSec).toBeCloseTo(0.5, 3)
  })

  it('drops words outside the trim range', () => {
    const words = [w('before', 0.5, 0.9), w('inside', 2.5, 2.9), w('after', 5, 5.4)]
    const segs = buildTimelineCaptions([src('m', 0, 2, 4)], { m: words })
    expect(segs.map((s) => s.text)).toEqual(['inside'])
  })

  it('places each audio source at its own timeline position', () => {
    const words = [w('a', 0.1, 0.5), w('b.', 0.6, 1.0)]
    const segs = buildTimelineCaptions(
      [src('m', 0, 0, 2), src('m', 2, 0, 2)],
      { m: words },
      { maxWords: 10, maxChars: 100 }
    )
    expect(segs.length).toBe(2)
    expect(segs[1].startSec).toBeCloseTo(2.1, 2)
  })

  it('breaks on a long pause', () => {
    const words = [w('one', 0, 0.3), w('two', 2.0, 2.3)]
    const segs = buildTimelineCaptions([src('m', 0, 0, 5)], { m: words }, { gapSec: 0.7 })
    expect(segs.map((s) => s.text)).toEqual(['one', 'two'])
  })
})
