import { describe, it, expect } from 'vitest'
import { parseSilence } from './silence'

describe('parseSilence', () => {
  it('parses start/end pairs', () => {
    const log = [
      '[silencedetect @ 0x1] silence_start: 2.5',
      '[silencedetect @ 0x1] silence_end: 3.8 | silence_duration: 1.3',
      '[silencedetect @ 0x1] silence_start: 7.0',
      '[silencedetect @ 0x1] silence_end: 7.6 | silence_duration: 0.6'
    ].join('\n')
    expect(parseSilence(log, 10)).toEqual([
      { start: 2.5, end: 3.8 },
      { start: 7.0, end: 7.6 }
    ])
  })
  it('closes a trailing silence at the duration', () => {
    const log = '[silencedetect] silence_start: 8.0'
    expect(parseSilence(log, 10)).toEqual([{ start: 8.0, end: 10 }])
  })
  it('returns nothing when there is no silence', () => {
    expect(parseSilence('frame= 100', 10)).toEqual([])
  })
})
