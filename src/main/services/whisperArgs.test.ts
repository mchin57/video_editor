import { describe, it, expect } from 'vitest'
import {
  buildTranscribeExtractArgs,
  buildWhisperArgs,
  decodeStartSec,
  dtwPreset,
  LEAD_IN_SEC,
  transcribeGainDb,
  TRANSCRIBE_MAX_BOOST_DB,
  TRANSCRIBE_TARGET_LUFS
} from './whisperArgs'

describe('dtwPreset', () => {
  it('maps the bundled model to its preset', () => {
    expect(dtwPreset('C:\\bin\\whisper\\ggml-small.en.bin')).toBe('small.en')
    expect(dtwPreset('/opt/whisper/ggml-base.en.bin')).toBe('base.en')
    expect(dtwPreset('ggml-medium.bin')).toBe('medium')
  })

  it('rewrites large model file names to dotted presets', () => {
    // whisper-cli REJECTS `large-v3` (exit 3); only `large.v3` is accepted.
    expect(dtwPreset('ggml-large-v3.bin')).toBe('large.v3')
    expect(dtwPreset('ggml-large-v2.bin')).toBe('large.v2')
    expect(dtwPreset('ggml-large-v3-turbo.bin')).toBe('large.v3.turbo')
  })

  it('sees through a quantisation suffix', () => {
    expect(dtwPreset('ggml-small.en-q5_1.bin')).toBe('small.en')
    expect(dtwPreset('ggml-large-v3-q8_0.bin')).toBe('large.v3')
  })

  it('returns null for anything it does not recognise', () => {
    // Critical: a MISMATCHED preset yields garbage timings at exit 0, so an
    // unknown model must run without DTW rather than get a guess.
    expect(dtwPreset('ggml-custom-finetune.bin')).toBeNull()
    expect(dtwPreset('ggml-large-v9.bin')).toBeNull()
    expect(dtwPreset('')).toBeNull()
  })
})

describe('buildWhisperArgs', () => {
  it('asks for one entry per word and the full JSON', () => {
    expect(buildWhisperArgs('m.bin', 'a.wav', 'out', null)).toEqual([
      '-m', 'm.bin', '-f', 'a.wav', '-ml', '1', '-sow', '-ojf', '-of', 'out', '-np'
    ])
  })

  it('pairs -dtw with -nfa', () => {
    // Without -nfa, flash attention (on by default) silently disables DTW and
    // every t_dtw comes back -1 — the bug looks unfixed.
    expect(buildWhisperArgs('m.bin', 'a.wav', 'out', 'small.en')).toEqual([
      '-m', 'm.bin', '-f', 'a.wav', '-ml', '1', '-sow', '-ojf', '-of', 'out', '-np',
      '-dtw', 'small.en', '-nfa'
    ])
  })
})

describe('buildWhisperArgs offset', () => {
  it('starts decoding at the offset, in milliseconds', () => {
    expect(buildWhisperArgs('m.bin', 'a.wav', 'out', 'small.en', 4.5539)).toEqual([
      '-m', 'm.bin', '-f', 'a.wav', '-ml', '1', '-sow', '-ojf', '-of', 'out', '-np',
      '-ot', '4554',
      '-dtw', 'small.en', '-nfa'
    ])
  })

  it('omits the offset when decoding from the start', () => {
    expect(buildWhisperArgs('m.bin', 'a.wav', 'out', null, 0)).not.toContain('-ot')
  })
})

describe('decodeStartSec', () => {
  it('skips an opening click and the room tone after it', () => {
    // Real silencedetect output for the teleprompter clip whose first sentence
    // whisper dropped: a 0.1s click at 0, a 16ms bump at 4.23, speech at 5.05.
    const silences = [
      { start: 0.104813, end: 4.233125 },
      { start: 4.249625, end: 5.053875 },
      { start: 6.116, end: 6.574125 }
    ]
    expect(decodeStartSec(silences, 25.43)).toBeCloseTo(5.053875 - LEAD_IN_SEC, 6)
  })

  it('decodes from the start when the file opens on speech', () => {
    expect(decodeStartSec([{ start: 2, end: 3 }], 10)).toBe(0)
  })

  it('never starts before zero', () => {
    expect(decodeStartSec([{ start: 0, end: 0.3 }], 10)).toBe(0)
  })

  it('finds speech after a leading silence that runs from zero', () => {
    expect(decodeStartSec([{ start: 0, end: 6 }, { start: 9, end: 10 }], 12)).toBeCloseTo(5.5, 6)
  })

  it('finds speech that only begins after the last silence', () => {
    expect(decodeStartSec([{ start: 0, end: 8 }], 12)).toBeCloseTo(7.5, 6)
  })

  it('decodes the whole file when nothing sustained is ever heard', () => {
    // Silent to the end, or only clicks: skipping would guess, so do not.
    expect(decodeStartSec([{ start: 0, end: 10 }], 10)).toBe(0)
    expect(decodeStartSec([{ start: 0.05, end: 10 }], 10)).toBe(0)
  })

  it('does not care what order the silences arrive in', () => {
    const silences = [
      { start: 4.249625, end: 5.053875 },
      { start: 0.104813, end: 4.233125 },
      { start: 6.116, end: 6.574125 }
    ]
    expect(decodeStartSec(silences, 25.43)).toBeCloseTo(4.553875, 6)
  })
})

describe('transcribeGainDb', () => {
  it('lifts a quiet source to the target', () => {
    // The real take that lost its first 23 seconds of captions.
    expect(transcribeGainDb(-37.7)).toBeCloseTo(TRANSCRIBE_TARGET_LUFS + 37.7, 6)
  })

  it('never cuts a source already at or above the target', () => {
    expect(transcribeGainDb(TRANSCRIBE_TARGET_LUFS)).toBe(0)
    expect(transcribeGainDb(-14)).toBe(0)
  })

  it('caps the boost so a speechless clip stays a quiet noise floor', () => {
    expect(transcribeGainDb(-69)).toBe(TRANSCRIBE_MAX_BOOST_DB)
  })

  it('does nothing without a measurement', () => {
    expect(transcribeGainDb(null)).toBe(0)
    expect(transcribeGainDb(Number.NaN)).toBe(0)
  })
})

describe('buildTranscribeExtractArgs', () => {
  const tail = ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'a.wav']

  it('writes a plain 16k mono wav when there is nothing to fold or boost', () => {
    expect(buildTranscribeExtractArgs('in.mp4', 'a.wav', null, 0)).toEqual([
      '-y', '-hide_banner', '-nostdin', '-i', 'in.mp4', '-vn', ...tail
    ])
  })

  it('folds first, then boosts behind a no-make-up limiter', () => {
    expect(buildTranscribeExtractArgs('in.mp4', 'a.wav', 'pan=stereo|c0=c1|c1=c1', 17.7)).toEqual([
      '-y', '-hide_banner', '-nostdin', '-i', 'in.mp4', '-vn',
      '-af', 'pan=stereo|c0=c1|c1=c1,volume=17.7dB,alimiter=limit=0.891:level=0',
      ...tail
    ])
  })

  it('folds without a limiter when there is no boost', () => {
    expect(buildTranscribeExtractArgs('in.mp4', 'a.wav', 'pan=stereo|c0=c0|c1=c0', 0)).toContain('pan=stereo|c0=c0|c1=c0')
    expect(buildTranscribeExtractArgs('in.mp4', 'a.wav', 'pan=stereo|c0=c0|c1=c0', 0).join(' ')).not.toContain('alimiter')
  })
})
