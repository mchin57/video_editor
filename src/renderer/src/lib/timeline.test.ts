import { describe, it, expect } from 'vitest'
import { extractAudioPieces, reorder, splitAudioClip, splitVideoLayer, trimVideoEnd, trimVideoStart } from './timeline'
import { makeVideoLayer } from '@shared/layers'
import type { AudioClip, Layer, VideoContent } from '@shared/project'

function audio(over: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'a',
    mediaId: 'm',
    startSec: 0,
    inSec: 0,
    outSec: 10,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    kind: 'music',
    ...over
  }
}

describe('extractAudioPieces', () => {
  const id = (() => {
    let n = 0
    return (): string => `p${n++}`
  })()
  it('returns one straight clip when there are no freezes', () => {
    const layer = makeVideoLayer('a', 'm', 4, 6) // start 4, in 0, out 6
    const pieces = extractAudioPieces(layer, layer.content as VideoContent, () => 'p')
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ startSec: 4, inSec: 0, outSec: 6, kind: 'extracted' })
  })
  it('splits at the freeze with a silent gap and keeps later audio in sync', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10) // start 0, in 0, out 10
    const c = { ...(layer.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
    const pieces = extractAudioPieces(layer, c, id)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toMatchObject({ startSec: 0, inSec: 0, outSec: 3 }) // plays 0→3
    // second piece pushed back by the 2s hold → starts at 5 (gap 3→5 is silent)
    expect(pieces[1]).toMatchObject({ startSec: 5, inSec: 3, outSec: 10 })
  })
  it('drops a zero-length sliver when a freeze sits at the clip start', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10)
    const c = { ...(layer.content as VideoContent), freezes: [{ atSec: 0, holdSec: 2 }] }
    const pieces = extractAudioPieces(layer, c, id)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: 10 }) // whole audio, delayed 2s
  })
})

describe('splitVideoLayer', () => {
  const makeId = (): string => 'new'
  it('splits a video layer at an absolute time, sharing the source', () => {
    const layer = makeVideoLayer('a', 'm', 4, 6) // startSec 4 → endSec 10; in 0, out 6
    const res = splitVideoLayer(layer, 7, makeId)
    expect(res).not.toBeNull()
    const [left, right] = res!
    expect(left.id).toBe('a')
    expect(left.endSec).toBe(7)
    expect((left.content as { outSec: number }).outSec).toBe(3) // in 0 + (7 - 4)
    expect(right.id).toBe('new')
    expect(right.startSec).toBe(7)
    expect((right.content as { inSec: number }).inSec).toBe(3)
    expect(right.endSec).toBe(10)
  })
  it('refuses to split at/outside the span, or non-video layers', () => {
    const layer = makeVideoLayer('a', 'm', 4, 6)
    expect(splitVideoLayer(layer, 4, makeId)).toBeNull()
    expect(splitVideoLayer(layer, 10, makeId)).toBeNull()
    expect(splitVideoLayer(layer, 2, makeId)).toBeNull()
    const text = { ...layer, content: { kind: 'text' as const, text: 'x', fontFamily: 'a', fontSizePx: 10, color: '#fff', pill: { enabled: false, color: '#000', padPx: 0 } } }
    expect(splitVideoLayer(text, 7, makeId)).toBeNull()
  })

  // A 10s clip (in 0, out 10) with a 2s hold at source 3s → window 0..12
  // (mimicking addFreeze, which extends endSec by the hold).
  const frozen = (): Layer => {
    const l = makeVideoLayer('a', 'm', 0, 10)
    return { ...l, endSec: 12, content: { ...(l.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] } }
  }
  const video = (l: Layer): VideoContent => l.content as VideoContent
  // Window invariant every half must keep: endSec − startSec = (out − in) + Σ holds.
  const invariant = (l: Layer): void => {
    const c = video(l)
    const holds = (c.freezes ?? []).reduce((s, f) => s + f.holdSec, 0)
    expect(l.endSec - l.startSec).toBeCloseTo(c.outSec - c.inSec + holds, 6)
  }

  it('splitting AFTER a hold keeps the hold on the left and maps the cut through it', () => {
    const [left, right] = splitVideoLayer(frozen(), 7, makeId)! // played 7 = source 5 (2s held)
    expect(left).toMatchObject({ endSec: 7 })
    expect(video(left)).toMatchObject({ outSec: 5, freezes: [{ atSec: 3, holdSec: 2 }] })
    expect(right).toMatchObject({ startSec: 7, endSec: 12 })
    expect(video(right).inSec).toBe(5)
    expect(video(right).freezes).toBeUndefined()
    invariant(left)
    invariant(right)
  })

  it('splitting BEFORE a hold moves the hold to the right half', () => {
    const [left, right] = splitVideoLayer(frozen(), 2, makeId)!
    expect(video(left)).toMatchObject({ outSec: 2 })
    expect(video(left).freezes).toBeUndefined()
    expect(video(right)).toMatchObject({ inSec: 2, freezes: [{ atSec: 3, holdSec: 2 }] })
    invariant(left)
    invariant(right)
  })

  it('splitting INSIDE a hold splits the hold duration across the halves', () => {
    const [left, right] = splitVideoLayer(frozen(), 4, makeId)! // hold spans played 3..5
    expect(video(left)).toMatchObject({ outSec: 3, freezes: [{ atSec: 3, holdSec: 1 }] })
    expect(video(right)).toMatchObject({ inSec: 3, freezes: [{ atSec: 3, holdSec: 1 }] })
    expect(left.endSec).toBe(4)
    expect(right.startSec).toBe(4)
    invariant(left)
    invariant(right)
  })

  describe('trimVideoStart / trimVideoEnd (freeze-aware)', () => {
    it('trimming the right edge keeps remaining hold time in the window', () => {
      const l = frozen()
      const t = trimVideoEnd(l, video(l), 8)
      expect(t.endSec).toBe(10) // 8s of source + the 2s hold
      expect(video(t)).toMatchObject({ outSec: 8, freezes: [{ atSec: 3, holdSec: 2 }] })
      invariant(t)
    })
    it('trimming the right edge past a hold drops it', () => {
      const l = frozen()
      const t = trimVideoEnd(l, video(l), 2)
      expect(t.endSec).toBe(2)
      expect(video(t).freezes).toBeUndefined()
      invariant(t)
    })
    it('trimming the left edge past a hold drops it and shifts start by its time too', () => {
      const l = frozen()
      const t = trimVideoStart(l, video(l), 5)
      expect(t.startSec).toBe(7) // 5s of trimmed source + the dropped 2s hold
      expect(t.endSec).toBe(12) // right edge untouched
      expect(video(t)).toMatchObject({ inSec: 5 })
      expect(video(t).freezes).toBeUndefined()
      invariant(t)
    })
    it('trimming the left edge before the hold keeps it', () => {
      const l = frozen()
      const t = trimVideoStart(l, video(l), 2)
      expect(t.startSec).toBe(2)
      expect(video(t)).toMatchObject({ inSec: 2, freezes: [{ atSec: 3, holdSec: 2 }] })
      invariant(t)
    })
  })
})

describe('splitAudioClip', () => {
  const makeId = (): string => 'new'
  it('splits a clip at a timeline time into two segments sharing the source', () => {
    const res = splitAudioClip(audio({ outSec: 10, fadeInSec: 1, fadeOutSec: 2 }), 4, 10, makeId)
    expect(res).not.toBeNull()
    const [left, right] = res!
    expect(left.id).toBe('a')
    expect(left.outSec).toBe(4)
    expect(left.fadeInSec).toBe(1) // outer fade-in kept
    expect(left.fadeOutSec).toBe(0) // seam is hard
    expect(right.id).toBe('new')
    expect(right.inSec).toBe(4)
    expect(right.outSec).toBe(10)
    expect(right.startSec).toBe(4)
    expect(right.fadeInSec).toBe(0) // seam is hard
    expect(right.fadeOutSec).toBe(2) // outer fade-out kept
  })
  it('accounts for the clip start and in-point when computing the cut', () => {
    const res = splitAudioClip(audio({ startSec: 5, inSec: 2, outSec: 12 }), 8, 0, makeId)
    const [left, right] = res!
    expect(left.outSec).toBe(5) // inSec 2 + (8 - 5)
    expect(right.inSec).toBe(5)
    expect(right.startSec).toBe(8)
  })
  it('keeps a whole-source clip whole on the right of the cut', () => {
    const res = splitAudioClip(audio({ outSec: 0 }), 4, 10, makeId) // 10s source
    const [left, right] = res!
    expect(left.outSec).toBe(4)
    expect(right.inSec).toBe(4)
    expect(right.outSec).toBe(0) // still "to the source end"
  })
  it('refuses to split at or outside the clip span', () => {
    expect(splitAudioClip(audio({ outSec: 10 }), 0, 10, makeId)).toBeNull()
    expect(splitAudioClip(audio({ outSec: 10 }), 10, 10, makeId)).toBeNull()
    expect(splitAudioClip(audio({ outSec: 10 }), 11, 10, makeId)).toBeNull()
    expect(splitAudioClip(audio({ startSec: 5, outSec: 10 }), 3, 10, makeId)).toBeNull()
  })
  it('guards only the lower edge when the source duration is unknown', () => {
    expect(splitAudioClip(audio({ outSec: 0 }), 0, 0, makeId)).toBeNull()
    const res = splitAudioClip(audio({ outSec: 0 }), 4, 0, makeId)
    expect(res?.[0].outSec).toBe(4)
  })
})

describe('reorder', () => {
  it('moves an item', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })
  it('is a no-op for invalid/equal indices', () => {
    expect(reorder(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(reorder(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })
})
