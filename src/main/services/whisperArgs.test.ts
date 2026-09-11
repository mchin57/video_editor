import { describe, it, expect } from 'vitest'
import { buildWhisperArgs, dtwPreset } from './whisperArgs'

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
