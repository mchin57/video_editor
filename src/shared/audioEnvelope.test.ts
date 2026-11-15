import { describe, expect, it } from 'vitest'
import type { AudioClip } from './project'
import {
  VOLUME_LINE_MAX_DB,
  VOLUME_LINE_SILENCE_DB,
  addVolumeKeyframe,
  clampLineDb,
  clipLinePoints,
  envelopeGainAt,
  fadeGainAt,
  hasVolumeLine,
  lineDbAt,
  lineGainAt,
  moveVolumeKeyframe,
  removeVolumeKeyframe,
  splitVolumeKeyframes,
  volumeLineDbAt,
  withVolumeKeyframes
} from './audioEnvelope'

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'A',
  mediaId: 'm',
  startSec: 10,
  inSec: 2,
  outSec: 8,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'music',
  ...over
})

const db = (g: number): number => 20 * Math.log10(g)

describe('the volume line (lineDbAt / lineGainAt)', () => {
  const p = [
    { t: 1, db: 0 },
    { t: 3, db: -12 },
    { t: 4, db: 6 }
  ]

  it('is flat at 0 dB (gain 1) with no points', () => {
    expect(lineDbAt([], 5)).toBe(0)
    expect(lineGainAt([], 5)).toBe(1)
  })

  it('holds the first value before the first point and the last after the last', () => {
    expect(lineDbAt(p, -100)).toBe(0)
    expect(lineDbAt(p, 0.999)).toBe(0)
    expect(lineDbAt(p, 4)).toBe(6)
    expect(lineDbAt(p, 99)).toBe(6)
    expect(db(lineGainAt(p, 99))).toBeCloseTo(6, 9)
  })

  it('is a straight line IN dB between points', () => {
    expect(lineDbAt(p, 2)).toBeCloseTo(-6, 9) // half way 0 → −12
    expect(lineDbAt(p, 1.5)).toBeCloseTo(-3, 9)
    expect(lineDbAt(p, 3.5)).toBeCloseTo(-3, 9) // half way −12 → +6
    expect(db(lineGainAt(p, 2))).toBeCloseTo(-6, 9)
    expect(lineGainAt(p, 2)).toBeCloseTo(Math.pow(10, -6 / 20), 12)
  })

  it('a single point is a flat line at its value', () => {
    expect(lineDbAt([{ t: 5, db: -9 }], 0)).toBe(-9)
    expect(lineDbAt([{ t: 5, db: -9 }], 50)).toBe(-9)
  })

  it('silence: a hold or a stretch wholly at the floor is gain 0; rising out of it starts at −60 dB', () => {
    const s = [
      { t: 1, db: VOLUME_LINE_SILENCE_DB },
      { t: 2, db: VOLUME_LINE_SILENCE_DB },
      { t: 3, db: 0 }
    ]
    expect(lineGainAt(s, 0)).toBe(0) // hold before
    expect(lineGainAt(s, 1.5)).toBe(0) // both ends silent
    expect(db(lineGainAt(s, 2))).toBeCloseTo(-60, 9) // the segment after the point applies
    expect(db(lineGainAt(s, 2.5))).toBeCloseTo(-30, 9)
    expect(lineGainAt(s, 3)).toBe(1)
    expect(
      lineGainAt(
        [
          { t: 1, db: 0 },
          { t: 2, db: VOLUME_LINE_SILENCE_DB }
        ],
        5
      )
    ).toBe(0) // hold after
  })
})

describe('clipLinePoints — source-anchored points on the timeline', () => {
  it('maps source seconds to timeline seconds (start + source − in)', () => {
    const c = clip({
      volumeKeyframes: [
        { sourceSec: 4, db: -6 },
        { sourceSec: 3, db: 0 }
      ]
    })
    expect(clipLinePoints(c, 8)).toEqual([
      { t: 11, db: 0 },
      { t: 12, db: -6 }
    ])
  })

  it('keeps the window’s points plus the nearest beyond each edge, so values inside are unchanged', () => {
    const c = clip({
      volumeKeyframes: [
        { sourceSec: 0, db: 3 },
        { sourceSec: 1, db: -20 },
        { sourceSec: 5, db: 0 },
        { sourceSec: 9, db: -10 },
        { sourceSec: 12, db: 6 }
      ]
    })
    const pts = clipLinePoints(c, 8)
    expect(pts.map((x) => x.t)).toEqual([9, 13, 17]) // source 1, 5, 9
    const full = (c.volumeKeyframes ?? []).map((k) => ({ t: 10 + k.sourceSec - 2, db: k.db })).sort((a, b) => a.t - b.t)
    for (let t = 10; t <= 16; t += 0.25) expect(lineDbAt(pts, t)).toBeCloseTo(lineDbAt(full, t), 9)
  })

  it('a line wholly outside the window collapses to the hold that reaches it', () => {
    expect(
      clipLinePoints(
        clip({
          volumeKeyframes: [
            { sourceSec: 0.5, db: -6 },
            { sourceSec: 1, db: -9 }
          ]
        }),
        8
      )
    ).toEqual([{ t: 9, db: -9 }])
    expect(
      clipLinePoints(
        clip({
          volumeKeyframes: [
            { sourceSec: 9, db: -3 },
            { sourceSec: 10, db: -9 }
          ]
        }),
        8
      )
    ).toEqual([{ t: 17, db: -3 }])
  })
})

describe('fadeGainAt — the preview twin of afade (linear)', () => {
  it('ramps 0 → 1 over the fade-in from the clip start, and 1 → 0 into the clip end', () => {
    const c = clip({ startSec: 10, fadeInSec: 2, fadeOutSec: 1 })
    expect(fadeGainAt(c, 6, 9)).toBe(0)
    expect(fadeGainAt(c, 6, 10)).toBe(0)
    expect(fadeGainAt(c, 6, 11)).toBeCloseTo(0.5, 12)
    expect(fadeGainAt(c, 6, 12)).toBe(1)
    expect(fadeGainAt(c, 6, 14)).toBe(1)
    expect(fadeGainAt(c, 6, 15.5)).toBeCloseTo(0.5, 12)
    expect(fadeGainAt(c, 6, 16)).toBe(0)
  })

  it('overlapping fades multiply, as chained afades do', () => {
    const c = clip({ startSec: 0, fadeInSec: 2, fadeOutSec: 2 })
    expect(fadeGainAt(c, 2, 1)).toBeCloseTo(0.5 * 0.5, 12)
  })

  it('no fades is unity', () => {
    expect(fadeGainAt(clip(), 6, 13)).toBe(1)
  })
})

describe('envelopeGainAt — fades × line', () => {
  it('multiplies the fade and the line at a timeline second', () => {
    const c = clip({
      startSec: 0,
      inSec: 0,
      outSec: 10,
      fadeInSec: 2,
      volumeKeyframes: [
        { sourceSec: 0, db: -6 },
        { sourceSec: 4, db: -6 }
      ]
    })
    expect(envelopeGainAt(c, 10, 1)).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 12)
    expect(db(envelopeGainAt(c, 10, 3))).toBeCloseTo(-6, 9)
    expect(envelopeGainAt(c, 10, 5)).toBeCloseTo(Math.pow(10, -6 / 20), 12)
  })

  it('a clip with neither is 1 everywhere', () => {
    expect(envelopeGainAt(clip(), 8, 12)).toBe(1)
  })

  it('a trimmed clip reads its line through the new in-point (points stay on their sound)', () => {
    const c = clip({
      startSec: 0,
      inSec: 0,
      outSec: 10,
      volumeKeyframes: [
        { sourceSec: 5, db: 0 },
        { sourceSec: 6, db: -20 }
      ]
    })
    const trimmed = { ...c, inSec: 3, startSec: 3 } // left edge in by 3 s: the sound doesn't slide
    for (const t of [4, 5.5, 6, 8]) expect(envelopeGainAt(trimmed, 10, t)).toBeCloseTo(envelopeGainAt(c, 10, t), 12)
  })
})

describe('editing the line', () => {
  it('clamps levels to silence … +12 and rounds to 0.1 dB', () => {
    expect(clampLineDb(20)).toBe(VOLUME_LINE_MAX_DB)
    expect(clampLineDb(-200)).toBe(VOLUME_LINE_SILENCE_DB)
    expect(clampLineDb(-3.04)).toBe(-3)
  })

  it('adds a point in time order and returns its index; a point within 10 ms is re-levelled instead', () => {
    const a = addVolumeKeyframe(
      [
        { sourceSec: 1, db: 0 },
        { sourceSec: 3, db: 0 }
      ],
      { sourceSec: 2.00049, db: -6.04 }
    )
    expect(a.points).toEqual([
      { sourceSec: 1, db: 0 },
      { sourceSec: 2, db: -6 },
      { sourceSec: 3, db: 0 }
    ])
    expect(a.index).toBe(1)
    const b = addVolumeKeyframe(a.points, { sourceSec: 2.004, db: -12 })
    expect(b.points).toHaveLength(3)
    expect(b.points[1]).toEqual({ sourceSec: 2, db: -12 })
    expect(b.index).toBe(1)
  })

  it('moves a point in level and time but never past a neighbour or out of the window', () => {
    const p = [
      { sourceSec: 1, db: 0 },
      { sourceSec: 2, db: 0 },
      { sourceSec: 3, db: 0 }
    ]
    expect(moveVolumeKeyframe(p, 1, { sourceSec: 2.5, db: -9 })[1]).toEqual({ sourceSec: 2.5, db: -9 })
    expect(moveVolumeKeyframe(p, 1, { sourceSec: 9, db: 30 })[1]).toEqual({ sourceSec: 2.99, db: 12 })
    expect(moveVolumeKeyframe(p, 1, { sourceSec: -9, db: -99 })[1]).toEqual({ sourceSec: 1.01, db: -60 })
    expect(moveVolumeKeyframe(p, 0, { sourceSec: -5, db: 0 }, { min: 0.5, max: 10 })[0].sourceSec).toBe(0.5)
    expect(moveVolumeKeyframe(p, 2, { sourceSec: 50, db: 0 }, { min: 0, max: 4 })[2].sourceSec).toBe(4)
    expect(moveVolumeKeyframe(p, 7, { sourceSec: 0, db: 0 })).toEqual(p) // no such point
  })

  it('removes a point by its sorted index', () => {
    expect(
      removeVolumeKeyframe(
        [
          { sourceSec: 3, db: 1 },
          { sourceSec: 1, db: 2 }
        ],
        0
      )
    ).toEqual([{ sourceSec: 3, db: 1 }])
  })

  it('an empty line removes the field; a non-empty one is stored sorted', () => {
    const c = clip({ volumeKeyframes: [{ sourceSec: 1, db: 0 }] })
    expect('volumeKeyframes' in withVolumeKeyframes(c, [])).toBe(false)
    expect(hasVolumeLine(withVolumeKeyframes(c, []))).toBe(false)
    expect(
      withVolumeKeyframes(c, [
        { sourceSec: 5, db: 0 },
        { sourceSec: 2, db: -1 }
      ]).volumeKeyframes
    ).toEqual([
      { sourceSec: 2, db: -1 },
      { sourceSec: 5, db: 0 }
    ])
    expect(withVolumeKeyframes(clip(), [])).toEqual(clip())
  })
})

describe('splitVolumeKeyframes — the pin at the cut', () => {
  it('keeps every point and pins the line’s value at the cut', () => {
    const p = [
      { sourceSec: 1, db: 0 },
      { sourceSec: 5, db: -20 }
    ]
    const s = splitVolumeKeyframes(p, 2)
    expect(s).toEqual([
      { sourceSec: 1, db: 0 },
      { sourceSec: 2, db: -5 },
      { sourceSec: 5, db: -20 }
    ])
    // The line itself is unchanged by the pin.
    for (const x of [0, 1.5, 2, 3, 4.5, 6]) expect(volumeLineDbAt(s, x)).toBeCloseTo(volumeLineDbAt(p, x), 9)
  })

  it('a flat line stays flat; a point already at the cut is the pin', () => {
    expect(splitVolumeKeyframes([], 3)).toEqual([])
    expect(splitVolumeKeyframes([{ sourceSec: 3, db: -4 }], 3)).toEqual([{ sourceSec: 3, db: -4 }])
  })

  it('a cut inside a silent stretch pins silence (the stretch stays silent)', () => {
    const s = splitVolumeKeyframes(
      [
        { sourceSec: 1, db: VOLUME_LINE_SILENCE_DB },
        { sourceSec: 3, db: VOLUME_LINE_SILENCE_DB }
      ],
      2
    )
    expect(s[1]).toEqual({ sourceSec: 2, db: VOLUME_LINE_SILENCE_DB })
  })
})
