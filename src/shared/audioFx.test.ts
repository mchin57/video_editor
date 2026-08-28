import { describe, expect, it } from 'vitest'
import {
  chorusVoices,
  DEFAULT_CHORUS,
  DEFAULT_ECHO,
  ECHO_MIN_TAP_GAIN,
  echoTaps,
  fxTailSec,
  normalizeChorus,
  normalizeEcho
} from './audioFx'

describe('echoTaps', () => {
  it('emits one explicit tap per repeat at multiples of the delay', () => {
    const taps = echoTaps({ delayMs: 200, decay: 0.5, repeats: 3 })
    expect(taps.map((t) => t.delayMs)).toEqual([200, 400, 600])
  })

  it('falls off geometrically — aecho has no feedback, so the tail is explicit', () => {
    const taps = echoTaps({ delayMs: 200, decay: 0.5, repeats: 3 })
    expect(taps.map((t) => t.gain)).toEqual([0.5, 0.25, 0.125])
  })

  it('stops once repeats drop below audibility instead of emitting silence', () => {
    const taps = echoTaps({ delayMs: 100, decay: 0.05, repeats: 6 })
    expect(taps.length).toBeLessThan(6)
    expect(taps.every((t) => t.gain >= ECHO_MIN_TAP_GAIN)).toBe(true)
  })

  it('always keeps at least one tap, however quiet', () => {
    expect(echoTaps({ delayMs: 100, decay: 0.05, repeats: 1 })).toHaveLength(1)
  })

  it('clamps out-of-range settings', () => {
    expect(normalizeEcho({ delayMs: 5, decay: 9, repeats: 99 })).toEqual({
      delayMs: 40,
      decay: 0.9,
      repeats: 6
    })
  })
})

describe('chorusVoices', () => {
  const voices = chorusVoices({ voices: 3, spreadMs: 30, detuneCents: 12 })

  it('fans the voices out evenly across the spread', () => {
    expect(voices.map((v) => v.delayMs)).toEqual([10, 20, 30])
  })

  it('alternates sharp/flat, widening toward the outermost voice', () => {
    expect(voices.map((v) => v.cents)).toEqual([4, -8, 12])
  })

  it('steps the level down so the copies sit at different volumes', () => {
    const gains = voices.map((v) => v.gain)
    expect(gains[0]).toBeGreaterThan(gains[1])
    expect(gains[1]).toBeGreaterThan(gains[2])
  })

  it('clamps out-of-range settings', () => {
    expect(normalizeChorus({ voices: 99, spreadMs: 0, detuneCents: 999 })).toEqual({
      voices: 5,
      spreadMs: 8,
      detuneCents: 50
    })
  })
})

describe('fxTailSec', () => {
  it('is the last echo tap — how far the effect rings out past the source', () => {
    expect(fxTailSec({ kind: 'echo', echo: { delayMs: 200, decay: 0.5, repeats: 3 } })).toBeCloseTo(0.6)
  })

  it('is the last chorus voice offset', () => {
    expect(fxTailSec({ kind: 'chorus', chorus: { voices: 2, spreadMs: 40, detuneCents: 10 } })).toBeCloseTo(0.04)
  })

  it('is positive for the shipped defaults', () => {
    expect(fxTailSec({ kind: 'echo', echo: DEFAULT_ECHO })).toBeGreaterThan(0)
    expect(fxTailSec({ kind: 'chorus', chorus: DEFAULT_CHORUS })).toBeGreaterThan(0)
  })
})
