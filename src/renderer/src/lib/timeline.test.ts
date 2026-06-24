import { describe, it, expect } from 'vitest'
import { reorder, splitAudioClip, splitVideoLayer } from './timeline'
import { makeVideoLayer } from '@shared/layers'
import type { AudioClip } from '@shared/project'

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
