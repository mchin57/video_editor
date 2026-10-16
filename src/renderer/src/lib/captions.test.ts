import { describe, it, expect } from 'vitest'
import { buildTimelineCaptions, makeCaption, NEW_CAPTION_TEXT, type CaptionSource } from './captions'
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

  it('keeps a word the cut lands inside when this side holds most of it', () => {
    const words = [w('head', 1.9, 2.3), w('mid', 2.8, 3.2), w('tail', 3.8, 4.05)]
    const segs = buildTimelineCaptions([src('m', 0, 2, 4)], { m: words }, { maxWords: 10, maxChars: 100 })
    expect(segs.map((s) => s.text)).toEqual(['head mid tail'])
  })

  it('gives a word the cut splits to the side holding more of it', () => {
    // Otherwise both halves caption it and the short side flashes a fragment
    // that belongs to its neighbour (measured on a real cut at 7.42s).
    const words = [w('split', 3.8, 4.4)]
    const left = buildTimelineCaptions([src('m', 0, 2, 4)], { m: words })
    const right = buildTimelineCaptions([src('m', 0, 4, 6)], { m: words })
    expect(left.map((s) => s.text)).toEqual([])
    expect(right.map((s) => s.text)).toEqual(['split'])
  })

  it('keeps a word that only just misses the trim, and pins it to the edge', () => {
    // Whisper alignment and a cut never agree to the millisecond.
    const words = [w('just-before', 1.85, 1.95), w('inside', 2.5, 2.9)]
    const segs = buildTimelineCaptions([src('m', 0, 2, 4)], { m: words }, { maxWords: 10, maxChars: 100 })
    expect(segs[0].words.map((x) => x.text)).toEqual(['just-before', 'inside'])
    expect(segs[0].startSec).toBeCloseTo(0, 3)
  })

  it('still drops a word that is properly outside the trim', () => {
    const words = [w('before', 0.5, 0.9), w('inside', 2.5, 2.9), w('after', 5, 5.4)]
    const segs = buildTimelineCaptions([src('m', 0, 2, 4)], { m: words })
    expect(segs.map((s) => s.text)).toEqual(['inside'])
  })

  it('shows a boundary word long enough to read instead of flashing it', () => {
    // `we're` measured 0.225s on a real clip: a 7-frame flash.
    const segs = buildTimelineCaptions([src('m', 0, 2, 4)], { m: [w('edge', 1.96, 2.06)] })
    expect(segs).toHaveLength(1)
    expect(segs[0].endSec - segs[0].startSec).toBeGreaterThanOrEqual(0.1)
  })

  it('ignores a source with no room', () => {
    expect(buildTimelineCaptions([src('m', 0, 4, 4)], { m: [w('x', 3.9, 4.1)] })).toEqual([])
  })

  it('breaks on a long pause', () => {
    const words = [w('one', 0, 0.3), w('two', 2.0, 2.3)]
    const segs = buildTimelineCaptions([src('m', 0, 0, 5)], { m: words }, { gapSec: 0.7 })
    expect(segs.map((s) => s.text)).toEqual(['one', 'two'])
  })
})

describe('makeCaption (＋ Caption)', () => {
  it('follows the lane style (no override) and spreads its words over the window', () => {
    const seg = makeCaption('c1', 4, 6)
    expect(seg).toMatchObject({ id: 'c1', startSec: 4, endSec: 6, text: NEW_CAPTION_TEXT, enabled: true })
    expect(seg.style).toBeUndefined()
    expect(seg.words.map((w) => w.text)).toEqual(['Your', 'caption', 'here'])
    expect(seg.words[0].startSec).toBe(4)
    expect(seg.words[2].endSec).toBeCloseTo(6)
  })
})
