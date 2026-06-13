import { describe, it, expect } from 'vitest'
import { buildTimelineCaptions } from './captions'
import type { Clip, CaptionWord } from '@shared/project'

function clip(id: string, mediaId: string, inSec: number, outSec: number): Clip {
  return { id, mediaId, inSec, outSec, crop: null, mute: false, gainDb: 0 }
}

const w = (text: string, startSec: number, endSec: number): CaptionWord => ({ text, startSec, endSec })

describe('buildTimelineCaptions', () => {
  it('groups words into short segments and breaks on sentence end', () => {
    const words = [w('look', 0, 0.4), w('at', 0.4, 0.6), w('the', 0.6, 0.8), w('sunset.', 0.8, 1.2), w('Wow', 1.3, 1.7)]
    const segs = buildTimelineCaptions([clip('c', 'm', 0, 5)], { m: words }, { maxWords: 6, maxChars: 100 })
    expect(segs.map((s) => s.text)).toEqual(['look at the sunset.', 'Wow'])
  })

  it('maps source-time words into timeline time, respecting trim', () => {
    // clip plays source [2,4); a word at source 2.5 → timeline 0.5
    const words = [w('hello', 2.5, 2.9)]
    const segs = buildTimelineCaptions([clip('c', 'm', 2, 4)], { m: words })
    expect(segs).toHaveLength(1)
    expect(segs[0].startSec).toBeCloseTo(0.5, 3)
  })

  it('drops words outside the trim range', () => {
    const words = [w('before', 0.5, 0.9), w('inside', 2.5, 2.9), w('after', 5, 5.4)]
    const segs = buildTimelineCaptions([clip('c', 'm', 2, 4)], { m: words })
    expect(segs.map((s) => s.text)).toEqual(['inside'])
  })

  it('concatenates across multiple clips with offsets', () => {
    const c0 = clip('c0', 'm', 0, 2) // contributes 0..2
    const c1 = clip('c1', 'm', 0, 2) // starts at timeline 2
    const words = [w('a', 0.1, 0.5), w('b.', 0.6, 1.0)]
    const segs = buildTimelineCaptions([c0, c1], { m: words }, { maxWords: 10, maxChars: 100 })
    // a,b. appear in c0 (0.1,0.6) and again in c1 (2.1,2.6)
    expect(segs.length).toBe(2)
    expect(segs[1].startSec).toBeCloseTo(2.1, 2)
  })

  it('breaks on a long pause', () => {
    const words = [w('one', 0, 0.3), w('two', 2.0, 2.3)] // 1.7s gap
    const segs = buildTimelineCaptions([clip('c', 'm', 0, 5)], { m: words }, { gapSec: 0.7 })
    expect(segs.map((s) => s.text)).toEqual(['one', 'two'])
  })
})
