import { describe, it, expect } from 'vitest'
import { parseWhisperJson, parseWhisperTranscript, MAX_WORD_SEC } from './whisperParse'

describe('parseWhisperJson', () => {
  it('maps offsets (ms) to seconds and trims text', () => {
    const words = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 480 }, text: ' Hello' },
        { offsets: { from: 480, to: 900 }, text: ' world' }
      ]
    })
    expect(words).toEqual([
      { text: 'Hello', startSec: 0, endSec: 0.48 },
      { text: 'world', startSec: 0.48, endSec: 0.9 }
    ])
  })
  it('drops non-speech annotations and empty/zero-length entries', () => {
    const words = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: ' [BLANK_AUDIO]' },
        { offsets: { from: 1000, to: 2000 }, text: '(music)' },
        { offsets: { from: 2000, to: 2000 }, text: 'zerolen' },
        { offsets: { from: 2000, to: 2500 }, text: '   ' },
        { offsets: { from: 2500, to: 3000 }, text: 'keep' }
      ]
    })
    expect(words.map((w) => w.text)).toEqual(['keep'])
  })
  it('handles missing transcription', () => {
    expect(parseWhisperJson({})).toEqual([])
  })
})

/** One `-ml 1` entry: a word, its DTW time in centiseconds, its segment offsets. */
const dtw = (
  text: string,
  tDtwCs: number | null,
  fromMs: number,
  toMs: number
): {
  text: string
  offsets: { from: number; to: number }
  tokens: { text: string; t_dtw: number }[]
} => ({
  text,
  offsets: { from: fromMs, to: toMs },
  tokens: tDtwCs === null ? [] : [{ text, t_dtw: tDtwCs }]
})

describe('parseWhisperTranscript', () => {
  it('prefers DTW times over the smeared segment offsets', () => {
    // Real shape from IMG_8743.MOV: the segment offsets claim "Was" at 0.00s,
    // but nothing is spoken until 2.42s. Trusting the offsets is what dropped
    // the first words of a clip trimmed anywhere before ~1.4s.
    const { words, timing } = parseWhisperTranscript({
      transcription: [
        dtw(' Was', 242, 0, 420),
        dtw(' this', 260, 420, 980),
        // By the tail of a file the smear has decayed, so the segment end is a
        // usable stop for the final word.
        dtw(' run.', 1068, 10430, 10760)
      ]
    })
    expect(timing).toBe('dtw')
    expect(words.map((w) => w.text)).toEqual(['Was', 'this', 'run.'])
    expect(words[0].startSec).toBeCloseTo(2.42, 3)
    expect(words[1].startSec).toBeCloseTo(2.6, 3)
    // A word ends where the next one begins...
    expect(words[0].endSec).toBeCloseTo(2.6, 3)
    // ...and the last falls back to its own segment end.
    expect(words[2].startSec).toBeCloseTo(10.68, 3)
    expect(words[2].endSec).toBeCloseTo(10.76, 3)
  })

  it('reads past whisper control tokens to the real text token', () => {
    // [_BEG_] and [_TT_nnn] always carry t_dtw -1; only text tokens are timed.
    const { words, timing } = parseWhisperTranscript({
      transcription: [
        { text: '', offsets: { from: 0, to: 0 }, tokens: [{ text: '[_BEG_]', t_dtw: -1 }] },
        {
          text: ' brick?',
          offsets: { from: 3230, to: 4400 },
          tokens: [
            { text: ' brick', t_dtw: 382 },
            { text: '?', t_dtw: 442 },
            { text: '[_TT_220]', t_dtw: -1 }
          ]
        },
        dtw(' No.', 456, 4400, 5400)
      ]
    })
    expect(timing).toBe('dtw')
    expect(words.map((w) => w.text)).toEqual(['brick?', 'No.'])
    expect(words[0].startSec).toBeCloseTo(3.82, 3)
  })

  it('caps a word window so it cannot absorb a pause and span a cut', () => {
    // "Club!" really ran 6.40 -> 10.84 and captioned itself on BOTH halves of a
    // cut at 7.42. Capped, it belongs to one side.
    const { words } = parseWhisperTranscript({
      transcription: [dtw(' Club!', 640, 6400, 10840), dtw(' Next', 1084, 10840, 11000)]
    })
    expect(words[0].endSec).toBeCloseTo(6.4 + MAX_WORD_SEC, 3)
  })

  it('gives a degenerate window a floor rather than dropping the word', () => {
    // The final word's stop comes from the segment timebase, which can land
    // BEFORE its DTW start. Shorten the word; never drop it.
    const { words, timing } = parseWhisperTranscript({
      transcription: [dtw(' a', 500, 5000, 5200), dtw(' b', 520, 5200, 5100)]
    })
    expect(timing).toBe('dtw')
    expect(words.map((w) => w.text)).toEqual(['a', 'b'])
    expect(words[1].endSec).toBeGreaterThan(words[1].startSec)
  })

  it('still drops noise annotations, but times the word before one correctly', () => {
    const { words } = parseWhisperTranscript({
      transcription: [
        dtw(' hello', 100, 1000, 1200),
        dtw(' [BLANK_AUDIO]', 130, 1200, 3000),
        dtw(' world', 300, 3000, 3200)
      ]
    })
    // "hello" ends at the annotation (1.30), not at "world" (3.00).
    expect(words.map((w) => w.text)).toEqual(['hello', 'world'])
    expect(words[0].endSec).toBeCloseTo(1.3, 3)
  })

  // --- the mismatched-preset trap: garbage DTW, exit code 0 ---

  it('falls back to segment timing when DTW collapses words onto one timestamp', () => {
    // Measured signature of `-dtw base.en` against a small.en model.
    const { words, timing } = parseWhisperTranscript({
      transcription: [
        dtw(' Was', 566, 0, 420),
        dtw(' this', 818, 420, 980),
        dtw(' run', 818, 980, 1400),
        dtw(' supposed', 818, 1400, 2530),
        dtw(' to', 818, 2530, 2810)
      ]
    })
    expect(timing).toBe('segment')
    expect(words[0].startSec).toBeCloseTo(0, 3)
  })

  it('falls back when DTW times run backwards', () => {
    const { timing } = parseWhisperTranscript({
      transcription: [dtw(' a', 500, 0, 400), dtw(' b', 200, 400, 800), dtw(' c', 900, 800, 1200)]
    })
    expect(timing).toBe('segment')
  })

  it('falls back when only some words carry a DTW time', () => {
    // Mixing the two timebases would reorder words, so take none of it.
    const { timing } = parseWhisperTranscript({
      transcription: [dtw(' a', 500, 0, 400), dtw(' b', null, 400, 800)]
    })
    expect(timing).toBe('segment')
  })

  it('reports segment timing for plain -oj output with no tokens', () => {
    const { words, timing } = parseWhisperTranscript({
      transcription: [
        { offsets: { from: 0, to: 480 }, text: ' Hello' },
        { offsets: { from: 480, to: 900 }, text: ' world' }
      ]
    })
    expect(timing).toBe('segment')
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world'])
  })

  it('handles missing transcription', () => {
    expect(parseWhisperTranscript({})).toEqual({ words: [], timing: 'segment' })
  })
})
