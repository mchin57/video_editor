import { describe, expect, it } from 'vitest'
import type { AudioClip } from '@shared/project'
import { VOLUME_LINE_MAX_DB, VOLUME_LINE_SILENCE_DB } from '@shared/audioEnvelope'
import { dbToFrac, fracToDb, pickedVolumePointIndex, sourceToX, volumeLinePolyline, xToSource } from './volumeLine'

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'A',
  mediaId: 'm',
  startSec: 4,
  inSec: 1,
  outSec: 5,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'music',
  ...over
})

describe('the tile’s level scale', () => {
  it('puts +12 at the top, 0 dB a quarter down and silence at the bottom', () => {
    expect(dbToFrac(VOLUME_LINE_MAX_DB)).toBe(0)
    expect(dbToFrac(0)).toBe(0.25)
    expect(dbToFrac(VOLUME_LINE_SILENCE_DB)).toBeCloseTo(1, 12)
    expect(dbToFrac(-6)).toBeGreaterThan(0.4) // a −6 dB dip is a visible dip
  })

  it('round-trips, and is monotonic (lower on the tile = quieter)', () => {
    let prev = -1
    for (let db = VOLUME_LINE_SILENCE_DB; db <= VOLUME_LINE_MAX_DB; db += 1.5) {
      expect(fracToDb(dbToFrac(db))).toBeCloseTo(db, 9)
      const f = dbToFrac(db)
      if (prev >= 0) expect(f).toBeLessThan(prev)
      prev = f
    }
    expect(fracToDb(-1)).toBe(VOLUME_LINE_MAX_DB)
    expect(fracToDb(2)).toBe(VOLUME_LINE_SILENCE_DB)
  })
})

describe('tile x ↔ source time', () => {
  it('maps through the in-point at the zoom', () => {
    expect(sourceToX(clip(), 3, 50)).toBe(100)
    expect(xToSource(clip(), 100, 50)).toBe(3)
  })
})

describe('volumeLinePolyline', () => {
  it('a flat clip is a straight line at 0 dB', () => {
    const pts = volumeLinePolyline(clip(), 5, 10, 40, 24, 10).split(' ')
    expect(pts).toEqual(['0.0,6.0', '10.0,6.0', '20.0,6.0', '30.0,6.0', '40.0,6.0'])
  })

  it('passes through every point at its own x and level', () => {
    const c = clip({
      volumeKeyframes: [
        { sourceSec: 2, db: 0 },
        { sourceSec: 3.55, db: -12 }
      ]
    })
    const pts = volumeLinePolyline(c, 5, 10, 40, 100, 50)
    expect(pts.split(' ')).toContain(`25.5,${(dbToFrac(-12) * 100).toFixed(1)}`)
    expect(pts.split(' ')).toContain('10.0,25.0')
    expect(pts.split(' ').at(-1)).toBe(`40.0,${(dbToFrac(-12) * 100).toFixed(1)}`) // held after the last
  })
})

describe('pickedVolumePointIndex', () => {
  const c = clip({
    volumeKeyframes: [
      { sourceSec: 3, db: 0 },
      { sourceSec: 2, db: -6 }
    ]
  })
  it('resolves a pick by sorted index + source second', () => {
    expect(pickedVolumePointIndex({ audioClips: [c] }, { clipId: 'A', index: 0, sourceSec: 2 })).toBe(0)
    expect(pickedVolumePointIndex({ audioClips: [c] }, { clipId: 'A', index: 1, sourceSec: 3 })).toBe(1)
  })
  it('a stale pick (moved, removed, other clip) is none', () => {
    expect(pickedVolumePointIndex({ audioClips: [c] }, { clipId: 'A', index: 0, sourceSec: 2.5 })).toBe(-1)
    expect(pickedVolumePointIndex({ audioClips: [c] }, { clipId: 'A', index: 5, sourceSec: 2 })).toBe(-1)
    expect(pickedVolumePointIndex({ audioClips: [c] }, { clipId: 'B', index: 0, sourceSec: 2 })).toBe(-1)
  })
})
