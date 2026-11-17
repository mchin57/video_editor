import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type AudioClip } from '../project'
import { makeImageLayer, makeVideoLayer, makeWorkoutLayer } from '../layers'
import { newWidget } from '../workoutOverlay'
import { summarizeTimeline } from './timelineSummary'
import type { SourceDuration } from '../compositions'

const audio = (over: Partial<AudioClip>): AudioClip => ({
  id: 'a1',
  mediaId: 'm1',
  startSec: 1,
  inSec: 0,
  outSec: 4,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'extracted',
  ...over
})

describe('summarizeTimeline', () => {
  it('describes a workout overlay: the stretch of the recording, its speed and what it shows', () => {
    const w = makeWorkoutLayer('w', 'fit1', 0, { inSec: 30, outSec: 830, speed: 100 }, [
      newWidget('power', [], 'a'),
      newWidget('liveMap', [], 'b')
    ])
    const [s] = summarizeTimeline({ ...createEmptyComposition(), layers: [w] }).layers
    expect(s).toMatchObject({
      kind: 'workout',
      mediaId: 'fit1',
      startSec: 0,
      endSec: 8,
      inSec: 30,
      outSec: 830,
      speed: 100,
      shows: ['power', 'liveMap']
    })
  })

  it('lists layers by start time with their source window', () => {
    const comp = {
      ...createEmptyComposition(),
      layers: [makeVideoLayer('v', 'm1', 1, 4), makeImageLayer('i', 'm2', 0, 2)],
      audioClips: [audio({ linkGroupId: 'g' })]
    }
    const s = summarizeTimeline(comp)
    expect(s.layers.map((l) => l.id)).toEqual(['i', 'v'])
    expect(s.layers[1]).toEqual({
      id: 'v',
      kind: 'video',
      startSec: 1,
      endSec: 5,
      hidden: false,
      mediaId: 'm1',
      inSec: 0,
      outSec: 4
    })
    expect(s.layers[0]).toMatchObject({ id: 'i', kind: 'image', mediaId: 'm2' })
    expect(s.audioClips).toEqual([
      { id: 'a1', mediaId: 'm1', startSec: 1, endSec: 5, inSec: 0, outSec: 4, linkGroupId: 'g' }
    ])
    expect(s.durationSec).toBe(5)
  })

  it('reports a clip’s volume line at the timeline seconds its points play; a flat clip has none', () => {
    const lined = audio({
      startSec: 5,
      inSec: 2,
      volumeKeyframes: [
        { sourceSec: 4, db: -60 },
        { sourceSec: 3, db: 0 }
      ]
    })
    const s = summarizeTimeline({ ...createEmptyComposition(), audioClips: [lined, audio({ id: 'a2' })] })
    expect(s.audioClips[0].volumeLine).toEqual([
      { atSec: 6, db: 0 },
      { atSec: 7, db: -60 }
    ])
    expect('volumeLine' in s.audioClips[1]).toBe(false)
  })

  it("reports a re-timed audio clip's speed and its holds on the timeline (#58)", () => {
    const re = audio({ startSec: 5, inSec: 2, outSec: 8, speed: 2, freezes: [{ atSec: 4, holdSec: 1.5 }] })
    const s = summarizeTimeline({ ...createEmptyComposition(), audioClips: [re, audio({ id: 'a2' })] })
    // 2..4 at 2× plays 5..6, silent 6..7.5, 4..8 plays 7.5..9.5.
    expect(s.audioClips[0]).toMatchObject({ endSec: 9.5, speed: 2, holds: [{ atSec: 6, holdSec: 1.5 }] })
    expect('speed' in s.audioClips[1] || 'holds' in s.audioClips[1]).toBe(false)
  })

  it('reports a whole-source audio clip with an open end', () => {
    const s = summarizeTimeline({ ...createEmptyComposition(), audioClips: [audio({ outSec: 0 })] })
    expect(s.audioClips[0]).toMatchObject({ endSec: null, outSec: null })
  })

  it('rounds to milliseconds', () => {
    const v = makeVideoLayer('v', 'm1', 0.123456, 1)
    expect(summarizeTimeline({ ...createEmptyComposition(), layers: [v] }).layers[0].startSec).toBe(0.123)
  })

  it('summarises an empty timeline', () => {
    expect(summarizeTimeline(createEmptyComposition())).toEqual({ durationSec: 0, layers: [], audioClips: [] })
  })

  it('reports durationSec as the max of bounded audio end and layers', () => {
    const comp = {
      ...createEmptyComposition(),
      layers: [makeVideoLayer('v', 'm1', 0, 2)],
      audioClips: [audio({ startSec: 0, inSec: 0, outSec: 5 })]
    }
    const s = summarizeTimeline(comp)
    expect(s.layers[0].endSec).toBe(2)
    expect(s.audioClips[0].endSec).toBe(5)
    expect(s.durationSec).toBe(5)
  })

  it('computes open-ended audio endSec when srcDur is provided', () => {
    const comp = {
      ...createEmptyComposition(),
      audioClips: [audio({ outSec: 0, mediaId: 'src1' })]
    }
    const srcDur: SourceDuration = (id) => (id === 'src1' ? 10 : 0)
    const s = summarizeTimeline(comp, srcDur)
    expect(s.audioClips[0]).toMatchObject({ inSec: 0, outSec: null, endSec: 11 })
    expect(s.durationSec).toBe(11)
  })

  it('keeps open-ended audio endSec as null when srcDur is not provided', () => {
    const comp = {
      ...createEmptyComposition(),
      audioClips: [audio({ outSec: 0, mediaId: 'm1' })]
    }
    const s = summarizeTimeline(comp)
    expect(s.audioClips[0]).toMatchObject({ endSec: null, outSec: null })
    expect(s.durationSec).toBe(1)
  })
})

describe('summarizeTimeline — transitions (#64)', () => {
  it('lists each edge’s transition, naming the clip a dissolve / dip joins it to', () => {
    const a = { ...makeVideoLayer('A', 'm', 0, 4), transitionOut: { kind: 'dissolve' as const, sec: 0.5 } }
    const b = {
      ...makeVideoLayer('B', 'm', 3.5, 4),
      transitionIn: { kind: 'dissolve' as const, sec: 0.5 },
      transitionOut: { kind: 'fade' as const, sec: 1 }
    }
    const [sa, sb] = summarizeTimeline({ ...createEmptyComposition(), layers: [a, b] }).layers
    expect(sa.transitionOut).toEqual({ kind: 'dissolve', sec: 0.5, withId: 'B' })
    expect(sa.transitionIn).toBeUndefined()
    expect(sb.transitionIn).toEqual({ kind: 'dissolve', sec: 0.5, withId: 'A' })
    expect(sb.transitionOut).toEqual({ kind: 'fade', sec: 1 })
  })

  it('a layer without transitions has neither field', () => {
    const [s] = summarizeTimeline({ ...createEmptyComposition(), layers: [makeImageLayer('I', 'm', 0, 3)] }).layers
    expect('transitionIn' in s).toBe(false)
    expect('transitionOut' in s).toBe(false)
  })
})
