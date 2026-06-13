import { describe, it, expect } from 'vitest'
import { parseWhisperJson } from './whisperParse'

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
