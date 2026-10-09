import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type AudioClip } from '../project'
import { makeImageLayer, makeVideoLayer } from '../layers'
import { summarizeTimeline } from './timelineSummary'

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
  it('lists layers by start time with their source window', () => {
    const comp = {
      ...createEmptyComposition(),
      layers: [makeVideoLayer('v', 'm1', 1, 4), makeImageLayer('i', 'm2', 0, 2)],
      audioClips: [audio({ linkGroupId: 'g' })]
    }
    const s = summarizeTimeline(comp)
    expect(s.layers.map((l) => l.id)).toEqual(['i', 'v'])
    expect(s.layers[1]).toEqual({ id: 'v', kind: 'video', startSec: 1, endSec: 5, hidden: false, mediaId: 'm1', inSec: 0, outSec: 4 })
    expect(s.layers[0]).toMatchObject({ id: 'i', kind: 'image', mediaId: 'm2' })
    expect(s.audioClips).toEqual([{ id: 'a1', mediaId: 'm1', startSec: 1, endSec: 5, inSec: 0, outSec: 4, linkGroupId: 'g' }])
    expect(s.durationSec).toBe(5)
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
})
