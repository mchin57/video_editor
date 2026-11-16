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

  it('reports a clip’s and a picture’s colour look in the Inspector’s words — only what is set (#105, #55)', () => {
    const v = makeVideoLayer('v', 'm1', 0, 4)
    const i = makeImageLayer('i', 'm2', 0, 2)
    const plain = makeVideoLayer('p', 'm1', 5, 6)
    const comp = {
      ...createEmptyComposition(),
      layers: [
        {
          ...v,
          content: {
            ...v.content,
            color: {
              brightness: 0.2,
              contrast: 1,
              saturation: 1.3,
              temperature: 0.4,
              greenMagenta: -0.25,
              vibrance: 0
            },
            tint: { color: '#ffd999', amount: 0.5 },
            lut: { file: '0123456789abcdef.cube', name: 'Warm', strength: 0.6 }
          }
        } as typeof v,
        { ...i, content: { ...i.content, lut: { file: 'x.cube', name: 'Off', strength: 0 } } } as typeof i,
        {
          ...plain,
          content: { ...plain.content, color: { brightness: 0, contrast: 1, saturation: 1 } }
        } as typeof plain
      ]
    }
    const s = summarizeTimeline(comp)
    expect(s.layers.find((l) => l.id === 'v')!.color).toEqual({
      exposure: 0.2,
      saturation: 1.3,
      temperature: 0.4,
      tint: -0.25,
      colorWash: { color: '#ffd999', amount: 0.5 },
      lut: { name: 'Warm', strength: 0.6 }
    })
    // A LUT at strength 0 and a neutral grade are no look at all.
    expect(s.layers.find((l) => l.id === 'i')!.color).toBeUndefined()
    expect(s.layers.find((l) => l.id === 'p')!.color).toBeUndefined()
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
