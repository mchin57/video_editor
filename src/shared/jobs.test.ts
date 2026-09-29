import { describe, it, expect } from 'vitest'
import { formatEta, isJobActive, jobEtaSec } from './jobs'

describe('isJobActive', () => {
  it('is true only while queued or running', () => {
    expect(isJobActive('queued')).toBe(true)
    expect(isJobActive('running')).toBe(true)
    for (const s of ['done', 'error', 'canceled'] as const) expect(isJobActive(s)).toBe(false)
  })
})

describe('jobEtaSec', () => {
  const t0 = 1_000_000
  it('extrapolates linearly from progress so far', () => {
    expect(jobEtaSec(0.25, t0, t0 + 10_000)).toBeCloseTo(30, 9) // 10s for a quarter → 30s left
    expect(jobEtaSec(0.5, t0, t0 + 60_000)).toBeCloseTo(60, 9)
  })
  it('stays quiet while there is too little signal, and once done', () => {
    expect(jobEtaSec(0.01, t0, t0 + 60_000)).toBeNull() // startup-dominated
    expect(jobEtaSec(0.5, t0, t0 + 1_000)).toBeNull() // too early
    expect(jobEtaSec(1, t0, t0 + 60_000)).toBeNull()
    expect(jobEtaSec(Number.NaN, t0, t0 + 60_000)).toBeNull()
  })
})

describe('formatEta', () => {
  it('reads as seconds, then minutes + seconds', () => {
    expect(formatEta(0.2)).toBe('1s')
    expect(formatEta(44.6)).toBe('45s')
    expect(formatEta(60)).toBe('1m')
    expect(formatEta(200)).toBe('3m 20s')
  })
})
