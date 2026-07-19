import { describe, it, expect } from 'vitest'
import type { VideoContent } from './project'
import {
  hasSpeedRamp,
  playedBetween,
  sortedRamp,
  sourceAfterPlayed,
  speedSegments,
  videoSpeedAtSource
} from './speed'

const base = (over: Partial<VideoContent> = {}): VideoContent => ({
  kind: 'video',
  mediaId: 'm',
  inSec: 0,
  outSec: 10,
  mute: false,
  gainDb: 0,
  crop: null,
  ...over
})

describe('hasSpeedRamp / sortedRamp', () => {
  it('absent or empty ramp is inactive', () => {
    expect(hasSpeedRamp(base())).toBe(false)
    expect(hasSpeedRamp(base({ speedRamp: [] }))).toBe(false)
    expect(sortedRamp(base())).toEqual([])
  })
  it('sorts by source time and clamps speeds to the allowed range', () => {
    const c = base({
      speedRamp: [
        { atSec: 5, speed: 99 },
        { atSec: 1, speed: 0.01 }
      ]
    })
    expect(sortedRamp(c)).toEqual([
      { atSec: 1, speed: 0.25 },
      { atSec: 5, speed: 4 }
    ])
  })
})

describe('videoSpeedAtSource', () => {
  it('no ramp: the constant speed everywhere', () => {
    expect(videoSpeedAtSource(base({ speed: 2 }), 3)).toBe(2)
    expect(videoSpeedAtSource(base(), 3)).toBe(1)
  })
  it('holds flat outside the first/last keyframe, linear between', () => {
    const c = base({
      speedRamp: [
        { atSec: 2, speed: 1 },
        { atSec: 6, speed: 3 }
      ]
    })
    expect(videoSpeedAtSource(c, 0)).toBe(1)
    expect(videoSpeedAtSource(c, 2)).toBe(1)
    expect(videoSpeedAtSource(c, 4)).toBe(2) // midpoint
    expect(videoSpeedAtSource(c, 6)).toBe(3)
    expect(videoSpeedAtSource(c, 9)).toBe(3)
  })
  it('a single keyframe acts as a constant speed', () => {
    const c = base({ speed: 2, speedRamp: [{ atSec: 3, speed: 0.5 }] })
    expect(videoSpeedAtSource(c, 0)).toBe(0.5)
    expect(videoSpeedAtSource(c, 9)).toBe(0.5) // ramp overrides `speed`
  })
})

describe('speedSegments', () => {
  it('constant speed yields one flat segment', () => {
    expect(speedSegments(base({ speed: 2 }), 1, 5)).toEqual([{ s0: 1, s1: 5, v0: 2, v1: 2 }])
  })
  it('splits at keyframes strictly inside the interval', () => {
    const c = base({
      speedRamp: [
        { atSec: 2, speed: 1 },
        { atSec: 6, speed: 3 }
      ]
    })
    const segs = speedSegments(c, 0, 10)
    expect(segs.map((s) => [s.s0, s.s1])).toEqual([
      [0, 2],
      [2, 6],
      [6, 10]
    ])
    expect(segs[0]).toMatchObject({ v0: 1, v1: 1 }) // flat before first kf
    expect(segs[1]).toMatchObject({ v0: 1, v1: 3 }) // the ramp
    expect(segs[2]).toMatchObject({ v0: 3, v1: 3 }) // flat after last kf
  })
})

describe('playedBetween', () => {
  it('reduces to span/speed for constant speed', () => {
    expect(playedBetween(base({ speed: 2 }), 1, 5)).toBeCloseTo(2, 12)
    expect(playedBetween(base(), 1, 5)).toBeCloseTo(4, 12)
  })
  it('is signed: reversed bounds negate', () => {
    expect(playedBetween(base({ speed: 2 }), 5, 1)).toBeCloseTo(-2, 12)
  })
  it('matches the closed-form log integral on a linear ramp', () => {
    // speed 1 → 2 over source [0, 4]: ∫ 1/(1+s/4) ds = 4·ln(2)
    const c = base({
      speedRamp: [
        { atSec: 0, speed: 1 },
        { atSec: 4, speed: 2 }
      ]
    })
    expect(playedBetween(c, 0, 4)).toBeCloseTo(4 * Math.log(2), 10)
    // partial: up to s=2 → 4·ln(1.5)
    expect(playedBetween(c, 0, 2)).toBeCloseTo(4 * Math.log(1.5), 10)
  })
  it('agrees with numeric integration on a multi-segment ramp', () => {
    const c = base({
      speedRamp: [
        { atSec: 1, speed: 0.5 },
        { atSec: 3, speed: 2 },
        { atSec: 7, speed: 0.25 }
      ]
    })
    // Trapezoid over 1/speed at fine steps.
    const n = 200000
    let sum = 0
    for (let i = 0; i < n; i++) {
      const a = (10 * i) / n
      const b = (10 * (i + 1)) / n
      sum += ((b - a) / 2) * (1 / videoSpeedAtSource(c, a) + 1 / videoSpeedAtSource(c, b))
    }
    expect(playedBetween(c, 0, 10)).toBeCloseTo(sum, 6)
  })
})

describe('sourceAfterPlayed', () => {
  const ramp = base({
    speedRamp: [
      { atSec: 1, speed: 0.5 },
      { atSec: 3, speed: 2 },
      { atSec: 7, speed: 0.25 }
    ]
  })

  it('is the inverse of playedBetween (round-trips across segments)', () => {
    for (const s of [0.5, 1, 1.7, 2.9, 3, 4.2, 6.9, 8.5, 10]) {
      const p = playedBetween(ramp, 0, s)
      expect(sourceAfterPlayed(ramp, 0, p)).toBeCloseTo(s, 9)
    }
  })
  it('round-trips from arbitrary starting points', () => {
    const p = playedBetween(ramp, 2.5, 6.5)
    expect(sourceAfterPlayed(ramp, 2.5, p)).toBeCloseTo(6.5, 9)
  })
  it('negative played walks backwards (and round-trips)', () => {
    for (const s of [0.2, 1.5, 3.3, 7.7]) {
      const p = playedBetween(ramp, s, 9) // forward s → 9
      expect(sourceAfterPlayed(ramp, 9, -p)).toBeCloseTo(s, 9)
    }
  })
  it('respects the limit cap in both directions', () => {
    expect(sourceAfterPlayed(ramp, 0, 100, 10)).toBe(10)
    expect(sourceAfterPlayed(ramp, 9, -100, 0)).toBe(0)
  })
  it('reduces to linear motion at constant speed', () => {
    expect(sourceAfterPlayed(base({ speed: 2 }), 1, 3)).toBeCloseTo(7, 12)
    expect(sourceAfterPlayed(base({ speed: 2 }), 7, -3)).toBeCloseTo(1, 12)
  })
})
