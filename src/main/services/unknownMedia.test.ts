import { describe, it, expect } from 'vitest'
import { createEmptyProject, mediaUses, referencedMediaIds } from '@shared/project'
import { isUnknownClip } from '@shared/media'
import { makeImageLayer, makeVideoLayer, makeWorkoutLayer } from '@shared/layers'
import { reconcileKind } from '@shared/media'
import { unknownRecords } from './unknownMedia'
import { isUnknownFingerprint } from './fingerprint'

const audio = (mediaId: string, outSec: number) => ({
  id: `a-${mediaId}`,
  mediaId,
  startSec: 0,
  inSec: 0,
  outSec,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'audio' as const
})

describe('mediaUses (the one media walker)', () => {
  it('reports each use with its kind and furthest source second, and referencedMediaIds dedupes it', () => {
    const p = createEmptyProject('p', 't')
    const v = makeVideoLayer('v', 'vid', 0, 3)
    if (v.content.kind === 'video') v.content = { ...v.content, inSec: 2, outSec: 7.5 }
    p.layers = [v, makeImageLayer('i', 'img', 0, 2, { frame: { x: 0, y: 0, w: 1080, h: 1920 }, aspect: 1 })]
    p.audioClips = [audio('vid', 7.5), audio('song', 0)]
    expect(mediaUses(p)).toEqual([
      { mediaId: 'vid', as: 'video', outSec: 7.5 },
      { mediaId: 'img', as: 'image', outSec: 0 },
      { mediaId: 'vid', as: 'audio', outSec: 7.5 },
      { mediaId: 'song', as: 'audio', outSec: 0 }
    ])
    expect(referencedMediaIds(p)).toEqual(['vid', 'img', 'song'])
  })
})

describe('unknownRecords', () => {
  it('makes a Missing placeholder for each used id nothing describes, typed and sized by its uses', () => {
    const p = createEmptyProject('p', 't')
    const v = makeVideoLayer('v', 'aaaaaaaaaaaa', 0, 3)
    if (v.content.kind === 'video') v.content = { ...v.content, outSec: 9 }
    p.layers = [v, makeVideoLayer('k', 'known0000000', 0, 1)]
    p.audioClips = [audio('aaaaaaaaaaaa', 9), audio('bbbbbbbbbbbb', 4)]
    const recs = unknownRecords(p, (id) => id === 'known0000000')
    expect(recs.map((r) => [r.id, r.kind, r.probe.durationSec, !!r.probe.video, !!r.probe.audio])).toEqual([
      ['aaaaaaaaaaaa', 'video', 9, true, true], // a video whose audio is also used
      ['bbbbbbbbbbbb', 'audio', 4, false, true]
    ])
    for (const r of recs) {
      expect(isUnknownClip(r)).toBe(true)
      expect(isUnknownFingerprint(r.fingerprint)).toBe(true)
      expect(r.relativePath).toBeNull()
      expect(r.fileName).toBe('Unknown clip')
    }
  })

  it('a recording only a workout overlay uses becomes a workout placeholder', () => {
    const p = createEmptyProject('p', 't')
    p.layers = [makeWorkoutLayer('w', 'cccccccccccc', 0, { inSec: 0, outSec: 600, speed: 75 }, [])]
    const [r] = unknownRecords(p, () => false)
    expect([r.kind, r.probe.durationSec, r.probe.video, r.probe.audio]).toEqual(['workout', 600, null, null])
    // Its kind reads back as a workout, so Relink asks for a workout file.
    expect(reconcileKind(r.kind, r.probe)).toBe('workout')
  })

  it('returns nothing when every used clip has a record', () => {
    const p = createEmptyProject('p', 't')
    p.layers = [makeVideoLayer('v', 'x', 0, 1)]
    expect(unknownRecords(p, () => true)).toEqual([])
  })
})
