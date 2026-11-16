import { describe, expect, it } from 'vitest'
import type { AudioClip } from './project'
import { audioClipEnd, effectiveOut } from './project'
import {
  audioExportHolds,
  audioHeldAt,
  audioHoldSpans,
  audioPlayedSec,
  audioRetimed,
  audioSourceAt,
  audioSpeed,
  audioTimelineAt
} from './audioTiming'
import { clipLinePoints, envelopeGainAt, fadeGainAt, lineGainAt } from './audioEnvelope'
import { sourceAtPlayed, playedDuration } from './speed'

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
  kind: 'extracted',
  ...over
})

/** A small deterministic spread of clips (no randomness in CI). */
function sampleClips(): AudioClip[] {
  const out: AudioClip[] = []
  for (const startSec of [0, 0.5, 3.25, 17]) {
    for (const [inSec, outSec] of [
      [0, 4],
      [1.2, 9.7],
      [5, 5.4],
      [3, 0] // whole-source (resolved through effectiveOut)
    ]) {
      out.push(clip({ startSec, inSec, outSec, fadeInSec: 0.5, fadeOutSec: 0.8 }))
    }
  }
  return out
}

const SRC_DUR = 12

// The arithmetic every audio caller used before the shared mapping existed —
// a straight offset. Spelled out here once, as the oracle the helpers must equal
// for a clip at 1× with no holds.
const old = {
  end: (c: AudioClip): number => c.startSec + Math.max(0, effectiveOut(c, SRC_DUR) - c.inSec),
  sourceAt: (c: AudioClip, t: number): number => c.inSec + (t - c.startSec),
  timelineAt: (c: AudioClip, s: number): number => c.startSec + (s - c.inSec)
}

describe('audio timing at 1× with no holds equals the old straight offset', () => {
  it('played length and timeline end', () => {
    for (const c of sampleClips()) {
      const eo = effectiveOut(c, SRC_DUR)
      expect(audioClipEnd(c, SRC_DUR)).toBe(old.end(c))
      expect(c.startSec + audioPlayedSec(c, eo)).toBe(old.end(c))
    }
  })

  it('source second under the playhead, inside the clip', () => {
    for (const c of sampleClips()) {
      const eo = effectiveOut(c, SRC_DUR)
      for (let k = 0; k <= 20; k++) {
        const t = c.startSec + ((old.end(c) - c.startSec) * k) / 20
        expect(audioSourceAt(c, eo, t)).toBeCloseTo(old.sourceAt(c, t), 12)
        expect(audioHeldAt(c, eo, t)).toBe(false)
      }
    }
  })

  it('timeline second of a source point — inside and outside the window', () => {
    for (const c of sampleClips()) {
      for (const s of [c.inSec - 1, c.inSec, c.inSec + 0.37, 6, 11.9, 30]) {
        expect(audioTimelineAt(c, s)).toBeCloseTo(old.timelineAt(c, s), 12)
      }
    }
  })

  it('the volume line and the fades land where they always did', () => {
    const lined = clip({
      fadeInSec: 0.4,
      fadeOutSec: 1,
      volumeKeyframes: [
        { sourceSec: 1, db: 0 },
        { sourceSec: 3, db: -12 },
        { sourceSec: 6.5, db: 3 },
        { sourceSec: 9, db: -30 }
      ]
    })
    const pts = clipLinePoints(lined, 8)
    expect(pts).toEqual([
      { t: old.timelineAt(lined, 1), db: 0 },
      { t: old.timelineAt(lined, 3), db: -12 },
      { t: old.timelineAt(lined, 6.5), db: 3 },
      { t: old.timelineAt(lined, 9), db: -30 }
    ])
    for (let t = 9.5; t < 17; t += 0.25) {
      const want = fadeGainAt(lined, Math.max(0, 8 - lined.inSec), t) * lineGainAt(pts, t)
      expect(envelopeGainAt(lined, 8, t)).toBeCloseTo(want, 12)
    }
  })

  it('an untimed clip reports no speed, no holds, nothing to export', () => {
    const c = clip()
    expect(audioSpeed(c)).toBe(1)
    expect(audioRetimed(c)).toBe(false)
    expect(audioHoldSpans(c, 8)).toEqual([])
    expect(audioExportHolds(c, 8)).toEqual([])
  })
})

describe('audio timing — a re-timed clip maps like a video layer', () => {
  it('2×: half the played length, source runs twice as fast', () => {
    const c = clip({ speed: 2 }) // source 2..8 → 3 s on the timeline
    expect(audioPlayedSec(c, 8)).toBe(3)
    expect(audioClipEnd(c, SRC_DUR)).toBe(13)
    expect(audioSourceAt(c, 8, 11)).toBeCloseTo(4, 12)
    expect(audioSourceAt(c, 8, 12.5)).toBeCloseTo(7, 12)
    expect(audioTimelineAt(c, 5)).toBeCloseTo(11.5, 12)
    expect(audioRetimed(c)).toBe(true)
  })

  it('0.5× with a hold: the hold is wall-clock silence at its source point', () => {
    // 2..4 plays over 4 s (10..14), then 1.5 s held at source 4 (14..15.5),
    // then 4..8 over 8 s (15.5..23.5).
    const c = clip({ speed: 0.5, freezes: [{ atSec: 4, holdSec: 1.5 }] })
    expect(audioPlayedSec(c, 8)).toBe(13.5)
    expect(audioSourceAt(c, 8, 12)).toBeCloseTo(3, 12)
    expect(audioHeldAt(c, 8, 13.99)).toBe(false)
    expect(audioHeldAt(c, 8, 14.5)).toBe(true)
    expect(audioSourceAt(c, 8, 14.5)).toBeCloseTo(4, 12)
    expect(audioHeldAt(c, 8, 15.5)).toBe(false)
    expect(audioSourceAt(c, 8, 17.5)).toBeCloseTo(5, 12)
    expect(audioTimelineAt(c, 4)).toBeCloseTo(14, 12) // the hold's start
    expect(audioTimelineAt(c, 5)).toBeCloseTo(17.5, 12)
    expect(audioHoldSpans(c, 8)).toEqual([{ index: 0, atSec: 4, holdSec: 1.5, startSec: 14, endSec: 15.5 }])
    // The export cuts the tempo-adjusted stream (no holds yet) 4 s in.
    expect(audioExportHolds(c, 8)).toEqual([{ atPlayedSec: 4, holdSec: 1.5 }])
  })

  it('the helpers are the shared Retimed mapping the video layers use', () => {
    const c = clip({ speed: 1.5, freezes: [{ atSec: 3, holdSec: 0.7 }] })
    const r = { inSec: 2, outSec: 8, speed: 1.5, freezes: [{ atSec: 3, holdSec: 0.7 }] }
    expect(audioPlayedSec(c, 8)).toBe(playedDuration(r))
    for (const t of [10, 10.4, 10.9, 11.5, 13, 14]) {
      expect(audioSourceAt(c, 8, t)).toBe(sourceAtPlayed(r, t - 10))
    }
  })

  it('the volume line pauses over a hold and its points follow the speed', () => {
    const c = clip({
      speed: 2,
      freezes: [{ atSec: 4, holdSec: 1 }],
      volumeKeyframes: [
        { sourceSec: 2, db: 0 },
        { sourceSec: 6, db: -20 }
      ]
    })
    // 2→4 plays 10..11, hold 11..12 at the line's midpoint (−10 dB), 4→6 plays 12..13.
    expect(clipLinePoints(c, 8)).toEqual([
      { t: 10, db: 0 },
      { t: 11, db: -10 },
      { t: 12, db: -10 },
      { t: 13, db: -20 }
    ])
  })

  it('the volume line pauses over a hold that sits exactly on a point', () => {
    const c = clip({
      inSec: 2,
      freezes: [{ atSec: 4, holdSec: 2 }],
      volumeKeyframes: [
        { sourceSec: 4, db: -6 },
        { sourceSec: 8, db: -20 }
      ]
    })
    // Source 4 plays at 12, the hold covers 12..14, then 4→8 plays 14..18.
    const pts = clipLinePoints(c, 8)
    expect(lineGainAt(pts, 13)).toBeCloseTo(lineGainAt(pts, 12), 12)
    expect(lineGainAt(pts, 14)).toBeCloseTo(lineGainAt(pts, 12), 12)
    expect(lineGainAt(pts, 18)).toBeLessThan(lineGainAt(pts, 14))
  })

  it('fades span the played length: a 0.5× clip fades out at its stretched end', () => {
    const c = clip({ speed: 0.5, fadeOutSec: 2 }) // 10..22
    expect(envelopeGainAt(c, 8, 19.9)).toBeCloseTo(1, 12)
    expect(envelopeGainAt(c, 8, 21)).toBeCloseTo(0.5, 12)
  })
})

describe('a hold is silence in the shared envelope (the preview twin of the padded export)', () => {
  it('envelopeGainAt is 0 inside a hold and unchanged outside it', () => {
    const c = clip({ speed: 2, freezes: [{ atSec: 4, holdSec: 1 }] }) // 10..11 sound, 11..12 silent, 12..14 sound
    expect(envelopeGainAt(c, 8, 10.5)).toBe(1)
    expect(envelopeGainAt(c, 8, 11.5)).toBe(0)
    expect(envelopeGainAt(c, 8, 12.5)).toBe(1)
  })
})
