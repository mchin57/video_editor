import { describe, expect, it } from 'vitest'
import { PHRASE_MAX_WORDS, phrases, transcriptPhraseText, transcriptWordText, wordsInRange } from './transcriptText'

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec })

describe('transcriptPhraseText', () => {
  it('splits on a pause of at least 0.6s', () => {
    const words = [w('hi', 0, 0.3), w('there', 0.35, 0.7), w('next', 1.4, 1.8)]
    expect(transcriptPhraseText(words)).toBe('[0.00–0.70] hi there\n[1.40–1.80] next')
  })

  it('splits after sentence punctuation even without a pause', () => {
    const words = [w('Done.', 0, 0.4), w('Now', 0.45, 0.7)]
    expect(transcriptPhraseText(words)).toBe('[0.00–0.40] Done.\n[0.45–0.70] Now')
  })

  it('caps a phrase at PHRASE_MAX_WORDS words', () => {
    const words = Array.from({ length: PHRASE_MAX_WORDS + 1 }, (_, i) => w(`w${i}`, i * 0.2, i * 0.2 + 0.1))
    expect(phrases(words).map((p) => p.length)).toEqual([PHRASE_MAX_WORDS, 1])
  })

  it('trims the whitespace whisper leaves on word text', () => {
    expect(transcriptPhraseText([w(' hello', 0, 0.2), w(' world', 0.25, 0.5)])).toBe('[0.00–0.50] hello world')
  })

  it('keeps only words overlapping the range', () => {
    const words = [w('a', 0, 1), w('b', 2, 3), w('c', 4, 5)]
    expect(wordsInRange(words, { fromSec: 2.5, toSec: 4.2 }).map((x) => x.text)).toEqual(['b', 'c'])
  })

  it('says so when there is no speech', () => {
    expect(transcriptPhraseText([])).toBe('(no speech)')
    expect(transcriptWordText([w('a', 0, 1)], { fromSec: 5, toSec: 6 })).toBe('(no speech)')
  })
})

describe('transcriptWordText', () => {
  it('prints one timed word per line', () => {
    expect(transcriptWordText([w('hi', 0, 0.3), w('there', 0.35, 0.7)])).toBe('0.00–0.30 hi\n0.35–0.70 there')
  })
})
