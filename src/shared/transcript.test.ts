import { describe, it, expect } from 'vitest'
import { isCurrentTranscript, TRANSCRIPT_VERSION, type Transcript } from './transcript'

const t = (extra: Partial<Transcript>): Transcript => ({
  mediaId: 'm',
  words: [],
  model: 'ggml-small.en.bin',
  createdAt: '2026-09-24T00:00:00.000Z',
  ...extra
})

describe('isCurrentTranscript', () => {
  it('accepts a transcript from the current pipeline', () => {
    expect(isCurrentTranscript(t({ timing: 'dtw', version: TRANSCRIPT_VERSION }))).toBe(true)
  })

  it('rejects a DTW transcript from before the lead-in skip', () => {
    // Version 1 wrote `timing` but no `version`. Those transcripts can be
    // missing a file's opening sentence, so they must be redone.
    expect(isCurrentTranscript(t({ timing: 'dtw' }))).toBe(false)
  })

  it('rejects the original segment-timed transcripts', () => {
    expect(isCurrentTranscript(t({}))).toBe(false)
  })
})
