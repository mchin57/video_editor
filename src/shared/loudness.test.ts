import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { isLoudnessSeries, windowLoudness, LOUDNESS_VERSION, type LoudnessSeries, type WindowLoudness } from './loudness'

/**
 * The real series of a 3:13 teleprompter recording (mono AAC, ~−36 LUFS with
 * long near-silent stretches), measured with `buildLoudnessArgs` on ffmpeg
 * 8.1.1. The expected values below are ffmpeg measuring each window DIRECTLY
 * on the same file (`aresample=48000,atrim=IN:OUT,asetpts=N/SR/TB` then
 * `ebur128` integrated loudness and `astats` Peak_level).
 */
const recovery = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'loudness-recovery-teleprompter.json'), 'utf8')
) as LoudnessSeries

const ok = (w: WindowLoudness): { lufs: number | null; peakDb: number | null } => {
  if (w.status !== 'ok') throw new Error(`expected a measurement, got ${w.status}`)
  return w
}

/** A synthetic series: every step at the same momentary loudness and peak. */
function flat(steps: number, m: number | null, peak: number | null = -10): LoudnessSeries {
  return {
    version: LOUDNESS_VERSION,
    stepSec: 0.1,
    startSec: 0,
    momentary: Array.from({ length: steps }, (_, i) => (i < 3 ? null : m)),
    peak: Array.from({ length: steps }, () => peak)
  }
}

describe('windowLoudness — golden windows (real file vs ffmpeg direct)', () => {
  it.each([
    [5, 20, -40.7],
    [30, 10, -59.2],
    [60, 25, -36.9],
    [120, 40, -34.9],
    [12, 3, -61.6]
  ])('in %d s for %d s → %d LUFS', (inSec, dur, lufs) => {
    const got = ok(windowLoudness(recovery, inSec, inSec + dur)).lufs!
    expect(got.toFixed(1)).toBe(lufs.toFixed(1)) // what ebur128 prints
  })

  it.each([
    [60, 25, -14.48],
    [30, 10, -22.16],
    [5, 20, -20.75],
    [120, 40, -12.17],
    [12, 3, -43.11]
  ])('peak of in %d s for %d s → %d dBFS', (inSec, dur, peak) => {
    expect(ok(windowLoudness(recovery, inSec, inSec + dur)).peakDb).toBeCloseTo(peak, 2)
  })
})

describe('windowLoudness — gating and edges', () => {
  it('is "too short" under one 400 ms block', () => {
    expect(windowLoudness(flat(50, -20), 1, 1.39)).toEqual({ status: 'tooShort' })
    expect(windowLoudness(flat(50, -20), 2, 2)).toEqual({ status: 'tooShort' })
    expect(ok(windowLoudness(flat(50, -20), 1, 1.4)).lufs).toBeCloseTo(-20, 6)
  })

  it('a steady signal integrates to its own momentary loudness', () => {
    expect(ok(windowLoudness(flat(100, -23), 0, 10)).lufs).toBeCloseTo(-23, 6)
  })

  it('drops blocks under the absolute gate; all-silent is null', () => {
    expect(ok(windowLoudness(flat(100, -75), 0, 10)).lufs).toBeNull()
    expect(windowLoudness(flat(100, null, null), 0, 10)).toEqual({ status: 'ok', lufs: null, peakDb: null })
  })

  it('drops blocks more than 10 LU under the absolute-gated mean (relative gate)', () => {
    // Half the blocks at −20, half at −45: the −45 ones sit under the relative
    // gate (≈ −33), so the result is −20, not the energy mean (≈ −23).
    const s = flat(200, -20)
    for (let i = 100; i < 200; i++) s.momentary[i] = -45
    expect(ok(windowLoudness(s, 0, 20)).lufs).toBeCloseTo(-20, 6)
    // −25 is inside the relative gate, so it does count.
    for (let i = 100; i < 200; i++) s.momentary[i] = -25
    const both = -0.691 + 10 * Math.log10((Math.pow(10, (-20 + 0.691) / 10) * 97 + Math.pow(10, (-25 + 0.691) / 10) * 100) / 197)
    expect(ok(windowLoudness(s, 0, 20)).lufs).toBeCloseTo(both, 6)
  })

  it('counts only blocks wholly inside the window', () => {
    // Entry i is the block (i−3 … i+1) × 0.1 s. A loud block ending at 1.0 s
    // (entry 9) is outside [1, 2); one ending at 1.4 s (entry 13) is inside.
    const s = flat(40, -30)
    s.momentary[9] = -5
    expect(ok(windowLoudness(s, 1, 2)).lufs).toBeCloseTo(-30, 6)
    s.momentary[13] = -5
    expect(ok(windowLoudness(s, 1, 2)).lufs!).toBeGreaterThan(-30)
  })

  it('snaps an off-grid window to the 0.1 s grid, always keeping a block from 0.4 s up', () => {
    const s = flat(40, -18)
    expect(ok(windowLoudness(s, 1.05, 1.45)).lufs).toBeCloseTo(-18, 6)
    expect(ok(windowLoudness(s, 1.149, 1.551)).lufs).toBeCloseTo(-18, 6)
  })

  it('takes the peak of every step the window touches', () => {
    const s = flat(40, -20, -30)
    s.peak[9] = -3 // the step 0.9–1.0 s
    expect(ok(windowLoudness(s, 1, 2)).peakDb).toBe(-30) // grid edge: not touched
    expect(ok(windowLoudness(s, 0.95, 2)).peakDb).toBe(-3)
    expect(ok(windowLoudness(s, 0.5, 0.91)).peakDb).toBe(-3)
  })

  it('reads the series in source time when the audio starts late', () => {
    const s = { ...flat(40, -40), startSec: 1 }
    for (let i = 13; i < 40; i++) s.momentary[i] = -20 // blocks from source 1.0 + 1.0 s on
    expect(ok(windowLoudness(s, 2, 3)).lufs).toBeCloseTo(-20, 6)
  })

  it('past the end of the audio there is nothing to measure', () => {
    expect(windowLoudness(flat(40, -20), 10, 12)).toEqual({ status: 'ok', lufs: null, peakDb: null })
  })
})

describe('isLoudnessSeries', () => {
  it('accepts the current version only', () => {
    expect(isLoudnessSeries(recovery)).toBe(true)
    expect(isLoudnessSeries({ ...recovery, version: LOUDNESS_VERSION + 1 })).toBe(false)
    expect(isLoudnessSeries(null)).toBe(false)
    expect(isLoudnessSeries({ version: LOUDNESS_VERSION })).toBe(false)
  })
})
