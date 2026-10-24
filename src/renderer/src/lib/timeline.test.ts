import { describe, it, expect } from 'vitest'
import {
  extractAudioPieces,
  MIN_HOLD_SEC,
  reorder,
  setFreezeHold,
  splitAudioClip,
  splitCaptionSegment,
  splitStaticLayer,
  splitVideoLayer,
  trimAudioEdge,
  trimCaptionEdge,
  trimLayerEdge,
  trimVideoEnd,
  trimVideoEndBy,
  trimVideoStart
} from './timeline'
import { layerTransformAt, makeGraphicsLayer, makeVideoLayer, playedVideoDuration } from '@shared/layers'
import { newMark, type GraphicMark } from '@shared/graphics'
import type { AudioClip, CaptionSegment, GraphicsContent, Layer, TextContent, VideoContent } from '@shared/project'

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
    const pieces = extractAudioPieces(layer, layer.content as VideoContent, () => 'p', false)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ startSec: 4, inSec: 0, outSec: 6, kind: 'extracted' })
  })
  it('splits at the freeze with a silent gap and keeps later audio in sync', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10) // start 0, in 0, out 10
    const c = { ...(layer.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
    const pieces = extractAudioPieces(layer, c, id, false)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toMatchObject({ startSec: 0, inSec: 0, outSec: 3 }) // plays 0→3
    // second piece pushed back by the 2s hold → starts at 5 (gap 3→5 is silent)
    expect(pieces[1]).toMatchObject({ startSec: 5, inSec: 3, outSec: 10 })
  })
  it('drops a zero-length sliver when a freeze sits at the clip start', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10)
    const c = { ...(layer.content as VideoContent), freezes: [{ atSec: 0, holdSec: 2 }] }
    const pieces = extractAudioPieces(layer, c, id, false)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: 10 }) // whole audio, delayed 2s
  })
  it('auto-join puts every piece in the Default volume level (off: none)', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10)
    const c = { ...(layer.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
    expect(extractAudioPieces(layer, c, id, true).map((p) => p.volumeLevelId)).toEqual(['default', 'default'])
    expect(extractAudioPieces(layer, c, id, false).every((p) => p.volumeLevelId === undefined)).toBe(true)
  })
})

describe('speed-aware trim & split', () => {
  const makeId = (): string => 'new'
  it('splits a 2× clip at the speed-scaled source point', () => {
    // start 0, in 0, out 10, speed 2 → plays 0..5 on the timeline.
    const base = makeVideoLayer('a', 'm', 0, 10)
    const layer: Layer = {
      ...base,
      endSec: 5,
      content: { ...(base.content as VideoContent), speed: 2 }
    }
    const res = splitVideoLayer(layer, 2, makeId)
    expect(res).not.toBeNull()
    const [left, right] = res!
    expect(left.endSec).toBe(2)
    expect((left.content as VideoContent).outSec).toBe(4) // 2 played s × 2
    expect(right.startSec).toBe(2)
    expect((right.content as VideoContent).inSec).toBe(4)
    // Both halves keep the invariant window = (out−in)/speed (+ holds).
    expect(left.endSec - left.startSec).toBeCloseTo(4 / 2)
    expect(right.endSec - right.startSec).toBeCloseTo((10 - 4) / 2)
  })

  it('trims a slow-mo clip with speed-scaled played time', () => {
    // start 0, in 0, out 10, speed 0.5 → plays 0..20.
    const base = makeVideoLayer('a', 'm', 0, 10)
    const layer: Layer = {
      ...base,
      endSec: 20,
      content: { ...(base.content as VideoContent), speed: 0.5 }
    }
    const c = layer.content as VideoContent
    // New in-point at source 2 → start shifts by 2/0.5 = 4 played seconds.
    expect(trimVideoStart(layer, c, 2).startSec).toBe(4)
    // New out-point at source 8 → end = 0 + 8/0.5 = 16.
    expect(trimVideoEnd(layer, c, 8).endSec).toBe(16)
  })
})

describe('ramp-aware trim & split', () => {
  const makeId = (): string => 'new'
  // in 0, out 4, speed ramps 1 → 2 over the whole source: played span 4·ln 2.
  const ramp = [
    { atSec: 0, speed: 1 },
    { atSec: 4, speed: 2 }
  ]
  const mkRamped = (): Layer => {
    const base = makeVideoLayer('a', 'm', 0, 4)
    const content: VideoContent = { ...(base.content as VideoContent), speedRamp: ramp }
    return { ...base, endSec: playedVideoDuration(content), content }
  }

  it('splits at the log-integral source point and both halves keep the invariant', () => {
    const layer = mkRamped()
    const res = splitVideoLayer(layer, 1, makeId)
    expect(res).not.toBeNull()
    const [left, right] = res!
    const cutSource = 4 * (Math.exp(0.25) - 1) // s(p=1)
    expect((left.content as VideoContent).outSec).toBeCloseTo(cutSource, 9)
    expect((right.content as VideoContent).inSec).toBeCloseTo(cutSource, 9)
    // Both halves keep the ramp and the window invariant.
    expect((left.content as VideoContent).speedRamp).toEqual(ramp)
    expect((right.content as VideoContent).speedRamp).toEqual(ramp)
    expect(left.endSec - left.startSec).toBeCloseTo(playedVideoDuration(left.content as VideoContent), 9)
    expect(right.endSec - right.startSec).toBeCloseTo(playedVideoDuration(right.content as VideoContent), 9)
    // The two windows sum to the original.
    expect(right.endSec - left.startSec).toBeCloseTo(4 * Math.log(2), 9)
  })

  it('trims keep endSec consistent with the ramp integral', () => {
    const layer = mkRamped()
    const c = layer.content as VideoContent
    const t = trimVideoStart(layer, c, 2)
    expect(t.startSec).toBeCloseTo(4 * Math.log(1.5), 9) // played time 0→2
    expect(t.endSec - t.startSec).toBeCloseTo(playedVideoDuration(t.content as VideoContent), 9)
    const e = trimVideoEnd(layer, c, 2)
    expect(e.endSec).toBeCloseTo(4 * Math.log(1.5), 9)
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
    const text = {
      ...layer,
      content: {
        kind: 'text' as const,
        text: 'x',
        fontFamily: 'a',
        fontSizePx: 10,
        color: '#fff',
        pill: { enabled: false, color: '#000', padPx: 0 }
      }
    }
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

  describe('trimVideoEndBy (the right edge walks back into a freeze)', () => {
    // A 10s clip frozen on its LAST frame for 2s → window 0..12.
    const endFrozen = (): Layer => {
      const l = makeVideoLayer('a', 'm', 0, 10)
      return { ...l, endSec: 12, content: { ...(l.content as VideoContent), freezes: [{ atSec: 10, holdSec: 2 }] } }
    }
    it('trims footage after the hold first, keeping the hold', () => {
      const l = frozen()
      const t = trimVideoEndBy(l, video(l), -1, 10)
      expect(t.endSec).toBeCloseTo(11, 9)
      expect(video(t)).toMatchObject({ outSec: 9, freezes: [{ atSec: 3, holdSec: 2 }] })
      invariant(t)
    })
    it('once past the footage, shortens the hold instead of dropping it', () => {
      const l = frozen()
      const t = trimVideoEndBy(l, video(l), -8, 10) // 7s of footage (3→10), then 1s of the hold
      expect(t.endSec).toBeCloseTo(4, 9)
      expect(video(t).outSec).toBeCloseTo(3, 9)
      expect(video(t).freezes).toEqual([{ atSec: 3, holdSec: 1 }])
      invariant(t)
    })
    it('a freeze on the last frame shortens straight away', () => {
      const l = endFrozen()
      const t = trimVideoEndBy(l, video(l), -0.5, 10)
      expect(t.endSec).toBeCloseTo(11.5, 9)
      expect(video(t)).toMatchObject({ outSec: 10, freezes: [{ atSec: 10, holdSec: 1.5 }] })
      invariant(t)
    })
    it('a used-up hold is dropped and the trim carries on into the footage before it', () => {
      const l = endFrozen()
      const t = trimVideoEndBy(l, video(l), -3, 10) // the 2s hold, then 1s of footage
      expect(t.endSec).toBeCloseTo(9, 9)
      expect(video(t).outSec).toBeCloseTo(9, 9)
      expect(video(t).freezes).toBeUndefined()
      invariant(t)
    })
    it('is continuous in the delta across the footage/hold boundaries — AT them too', () => {
      const l = frozen()
      const at = (d: number): number => trimVideoEndBy(l, video(l), d, 10).endSec
      for (const b of [-7, -9]) {
        expect(at(b + 1e-6)).toBeCloseTo(at(b - 1e-6), 4)
        expect(at(b)).toBeCloseTo(12 + b, 9) // regression: exactly -9 once collapsed the clip to 0.1s
      }
      // A freeze on the last frame, used up exactly by the delta.
      const e = endFrozen()
      expect(trimVideoEndBy(e, video(e), -2, 10).endSec).toBeCloseTo(10, 9)
    })
    it('drops a hold the edge cuts to under a millisecond, instead of leaving a sliver', () => {
      const l = frozen()
      const t = trimVideoEndBy(l, video(l), -8.9995, 10)
      expect(video(t).freezes).toBeUndefined()
      expect(t.endSec).toBeCloseTo(3, 9)
      invariant(t)
    })
    it('shortens a hold on the last frame of a clip already at its minimum source span', () => {
      const base = makeVideoLayer('a', 'm', 0, 10)
      const c: VideoContent = { ...video(base), outSec: 0.1, freezes: [{ atSec: 0.1, holdSec: 2 }] }
      const l: Layer = { ...base, endSec: 2.1, content: c }
      const t = trimVideoEndBy(l, c, -1, 10)
      expect(video(t).freezes).toEqual([{ atSec: 0.1, holdSec: 1 }])
      expect(t.endSec).toBeCloseTo(1.1, 9)
    })
    it('lengthening extends the footage up to the source end', () => {
      const l = trimVideoEndBy(frozen(), video(frozen()), -2, 20) // out 8, window 0..10
      const t = trimVideoEndBy(l, video(l), 50, 20)
      expect(video(t)).toMatchObject({ outSec: 20, freezes: [{ atSec: 3, holdSec: 2 }] })
      expect(t.endSec).toBeCloseTo(22, 9)
    })
    it('keeps the minimum source span, and a hold at the very start stays whole', () => {
      const base = makeVideoLayer('a', 'm', 0, 10)
      const l: Layer = { ...base, endSec: 12, content: { ...video(base), freezes: [{ atSec: 0, holdSec: 2 }] } }
      const t = trimVideoEndBy(l, video(l), -50, 10)
      expect(video(t).outSec).toBeCloseTo(0.1, 9)
      expect(video(t).freezes).toEqual([{ atSec: 0, holdSec: 2 }])
      invariant(t)
    })
    it('walks the footage through the clip speed (2× = half the timeline time)', () => {
      const base = makeVideoLayer('a', 'm', 0, 10)
      const c: VideoContent = { ...video(base), speed: 2, freezes: [{ atSec: 6, holdSec: 2 }] }
      const l: Layer = { ...base, endSec: 7, content: c } // 5s played + 2s hold
      const t = trimVideoEndBy(l, c, -3, 10) // 2s of played footage (source 6→10), then 1s of hold
      expect(video(t).outSec).toBeCloseTo(6, 9)
      expect(video(t).freezes).toEqual([{ atSec: 6, holdSec: 1 }])
      expect(t.endSec).toBeCloseTo(4, 9)
    })
    it('a group trim takes the same path (trimLayerEdge)', () => {
      const l = frozen()
      const { tile, achieved } = trimLayerEdge(l, 'end', -8, 10)
      expect(achieved).toBeCloseTo(-8, 9)
      expect(video(tile).freezes).toEqual([{ atSec: 3, holdSec: 1 }])
    })
  })

  describe('setFreezeHold', () => {
    it('changes one hold and moves only the clip end', () => {
      const l = frozen()
      const t = setFreezeHold(l, video(l), 0, 3.5)
      expect(t.startSec).toBe(0)
      expect(t.endSec).toBeCloseTo(13.5, 9)
      expect(video(t).freezes).toEqual([{ atSec: 3, holdSec: 3.5 }])
      invariant(t)
    })
    it(`never shortens a hold below ${MIN_HOLD_SEC}s, and ignores a missing freeze`, () => {
      const l = frozen()
      expect(video(setFreezeHold(l, video(l), 0, -4)).freezes).toEqual([{ atSec: 3, holdSec: MIN_HOLD_SEC }])
      expect(setFreezeHold(l, video(l), 3, 1)).toBe(l)
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
  it('keeps the volume level on both halves', () => {
    const [left, right] = splitAudioClip(audio({ outSec: 10, volumeLevelId: 'lvl' }), 4, 10, makeId)!
    expect(left.volumeLevelId).toBe('lvl')
    expect(right.volumeLevelId).toBe('lvl')
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

describe('edge trims report what they achieved', () => {
  // `achieved` is what lets a group trim find the delta every member can absorb,
  // so a trim cut short by the source/minimum window must say so.
  it('gives back the full delta when there is room', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10) // 0..10, source 0..10
    expect(trimLayerEdge(layer, 'end', -3, 10).achieved).toBeCloseTo(-3, 5)
    expect(trimLayerEdge(layer, 'start', 2, 10).achieved).toBeCloseTo(2, 5)
  })

  it('reports the shortfall when the source runs out', () => {
    const layer = makeVideoLayer('a', 'm', 0, 10)
    // Growing the right edge past a 10s source achieves nothing.
    expect(trimLayerEdge(layer, 'end', 5, 10).achieved).toBe(0)
    // Shrinking past the minimum source span stops at 9.9s.
    expect(trimLayerEdge(layer, 'end', -20, 10).achieved).toBeCloseTo(-9.9, 5)
  })

  it('converts the delta through a clip’s speed profile', () => {
    const base = makeVideoLayer('a', 'm', 0, 10)
    const layer: Layer = { ...base, endSec: 5, content: { ...(base.content as VideoContent), speed: 2 } }
    const { tile, achieved } = trimLayerEdge(layer, 'end', -1, 10)
    expect(achieved).toBeCloseTo(-1, 5) // one TIMELINE second...
    expect((tile.content as VideoContent).outSec).toBeCloseTo(8, 5) // ...= 2s of source
  })

  it('keeps a minimum window on a text layer and a caption', () => {
    const layer: Layer = {
      id: 'T1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 0,
      y: 0,
      scale: 1,
      content: { kind: 'text', text: 'x' } as Layer['content']
    }
    expect(trimLayerEdge(layer, 'end', -10).tile.endSec).toBe(0.2)
    const seg: CaptionSegment = { id: 'C1', startSec: 0, endSec: 4, text: 'x', words: [], enabled: true }
    expect(trimCaptionEdge(seg, 'end', -10).tile.endSec).toBe(0.1)
    expect(trimCaptionEdge(seg, 'start', 10).tile.startSec).toBe(3.9)
  })

  it('re-bases graphics marks on a start trim so they keep their moment, both ways', () => {
    const g = makeGraphicsLayer('G', 2, 8)
    g.content = {
      kind: 'graphics',
      marks: [{ ...newMark('arrow', 'a', { x: 0, y: 0 }, { x: 200, y: 0 }, 3), reveal: 'draw' }]
    }
    const marksOf = (l: Layer): GraphicMark[] => (l.content as GraphicsContent).marks
    // Start 1s later: the arrow still appears at 5s, now 2s into the tile.
    expect(marksOf(trimLayerEdge(g, 'start', 1).tile)[0]).toMatchObject({ atSec: 2, reveal: 'draw' })
    // Start 1.5s earlier: 4.5s into the tile, still at 5s.
    expect(marksOf(trimLayerEdge(g, 'start', -1.5).tile)[0].atSec).toBeCloseTo(4.5)
    // Trimmed past it: its moment is kept as a negative time (on screen from
    // the new start), so trimming back out restores it exactly.
    const past = trimLayerEdge(g, 'start', 4).tile
    expect(marksOf(past)[0]).toMatchObject({ atSec: -1, reveal: 'draw' })
    expect(marksOf(trimLayerEdge(past, 'start', -4).tile)[0].atSec).toBeCloseTo(3)
    // The end edge leaves the marks alone.
    expect(marksOf(trimLayerEdge(g, 'end', -2).tile)).toBe(marksOf(g))
  })

  it('moves an audio clip’s start with its in-point, and bounds its out by the source', () => {
    const clip = audio({ startSec: 4, inSec: 2, outSec: 8 })
    const left = trimAudioEdge(clip, 'start', 1, 10)
    expect(left.tile).toMatchObject({ inSec: 3, startSec: 5 })
    expect(left.achieved).toBe(1)
    const right = trimAudioEdge(clip, 'end', 5, 10) // source ends at 10, out is 8
    expect(right.tile.outSec).toBe(10)
    expect(right.achieved).toBe(2)
  })

  it('falls back to the clip’s own out-point when the source duration is unknown', () => {
    const clip = audio({ outSec: 6 })
    expect(trimAudioEdge(clip, 'end', 3, 0).achieved).toBe(0) // can't grow past 6
    expect(trimAudioEdge(clip, 'end', -2, 0).tile.outSec).toBe(4)
  })
})

describe('splitStaticLayer', () => {
  const makeId = (): string => 'new'
  /** A text layer over [start, end] with an optional animation / keyframes. */
  function text(over: Partial<Layer> = {}, content: Partial<TextContent> = {}): Layer {
    return {
      id: 'T1',
      hidden: false,
      startSec: 0,
      endSec: 10,
      x: 540,
      y: 960,
      scale: 1,
      ...over,
      content: {
        kind: 'text',
        text: 'hello',
        fontFamily: 'inter',
        fontSizePx: 76,
        color: '#fff',
        pill: { enabled: false, color: '#000', padPx: 18 },
        ...content
      } as TextContent
    }
  }

  it('splits into two adjacent windows over the same content', () => {
    const res = splitStaticLayer(text(), 4, makeId)
    const [left, right] = res!
    expect([left.startSec, left.endSec]).toEqual([0, 4])
    expect([right.startSec, right.endSec]).toEqual([4, 10])
    expect(right.id).toBe('new')
    expect(right.content).toEqual(left.content) // same text, no trim to divide
  })

  it('refuses to split at or outside the span, or on a video/layout layer', () => {
    expect(splitStaticLayer(text(), 0, makeId)).toBeNull()
    expect(splitStaticLayer(text(), 10, makeId)).toBeNull()
    expect(splitStaticLayer(text(), 12, makeId)).toBeNull()
    expect(splitStaticLayer(makeVideoLayer('a', 'm', 0, 10), 4, makeId)).toBeNull()
  })

  it('splits a graphics tile so every mark keeps its moment: left before the cut, right re-based', () => {
    const g = makeGraphicsLayer('G', 2, 10)
    const mark = (id: string, atSec: number, reveal: GraphicMark['reveal'] = 'fade'): GraphicMark => ({
      ...newMark('line', id, { x: 0, y: 0 }, { x: 100, y: 0 }, atSec),
      reveal
    })
    g.content = { kind: 'graphics', marks: [mark('early', 1), mark('late', 5, 'draw')] }
    const [left, right] = splitStaticLayer(g, 5, makeId)! // cut 3s into the tile
    expect((left.content as GraphicsContent).marks.map((m) => m.id)).toEqual(['early'])
    const r = (right.content as GraphicsContent).marks
    // Already on screen at the cut: its moment is kept (before the right half's start).
    expect(r[0]).toMatchObject({ atSec: -2, reveal: 'fade' })
    // Still to come: same absolute time (2 + 5 = 7 = 5 + 2).
    expect(r[1]).toMatchObject({ atSec: 2, reveal: 'draw' })
    // The right half's marks are its own (fresh ids).
    expect(r.map((m) => m.id)).toEqual(['new', 'new'])
  })

  it('gives the entrance to the left half and the exit to the right', () => {
    const anim = { in: 'fadeIn' as const, inSec: 0.3, out: 'fadeOut' as const, outSec: 0.4 }
    const [left, right] = splitStaticLayer(text({}, { animation: anim }), 4, makeId)!
    expect((left.content as TextContent).animation).toEqual({ ...anim, out: 'none' })
    expect((right.content as TextContent).animation).toEqual({ ...anim, in: 'none' })
  })

  it('keeps a wordHighlight on both halves (it spans the window, not the entrance)', () => {
    const anim = { in: 'wordHighlight' as const, inSec: 0.3, out: 'none' as const, outSec: 0.3 }
    const [left, right] = splitStaticLayer(text({}, { animation: anim }), 4, makeId)!
    expect((left.content as TextContent).animation?.in).toBe('wordHighlight')
    expect((right.content as TextContent).animation?.in).toBe('wordHighlight')
  })

  it('partitions keyframes and pins the interpolated transform at the seam', () => {
    // x ramps 0 → 100 over 0..10s, so the cut at 4s sits at x = 40.
    const layer = text({
      keyframes: [
        { tSec: 0, x: 0, y: 960, scale: 1 },
        { tSec: 10, x: 100, y: 960, scale: 1 }
      ]
    })
    const [left, right] = splitStaticLayer(layer, 4, makeId)!
    expect(left.keyframes).toEqual([
      { tSec: 0, x: 0, y: 960, scale: 1 },
      { tSec: 4, x: 40, y: 960, scale: 1 }
    ])
    // Re-based onto the new start, and the motion continues from x = 40.
    expect(right.keyframes).toEqual([
      { tSec: 0, x: 40, y: 960, scale: 1 },
      { tSec: 6, x: 100, y: 960, scale: 1 }
    ])
    // The seam is invisible: both halves report the same transform there.
    expect(layerTransformAt(left, 4)).toEqual(layerTransformAt(right, 4))
  })

  it('carries a keyframed opacity across the seam', () => {
    // A 0 → 1 fade over 0..4s, cut at 2s: both seam keyframes sit at 0.5.
    const layer = text({
      keyframes: [
        { tSec: 0, x: 540, y: 960, scale: 1, opacity: 0 },
        { tSec: 4, x: 540, y: 960, scale: 1, opacity: 1 }
      ],
      endSec: 8
    })
    const [left, right] = splitStaticLayer(layer, 2, makeId)!
    expect(left.keyframes?.[1]).toMatchObject({ tSec: 2, opacity: 0.5 })
    expect(right.keyframes?.[0]).toMatchObject({ tSec: 0, opacity: 0.5 })
    // Keyframes on the far side are copied verbatim (only re-based) — an
    // explicit opacity the user set is never rewritten.
    expect(right.keyframes?.[1]).toEqual({ tSec: 2, x: 540, y: 960, scale: 1, opacity: 1 })
  })

  it('stores a synthesized seam keyframe at full opacity as ABSENCE', () => {
    // No opacity anywhere → the seam keyframes must not sprout `opacity: 1`,
    // which would push the layer onto the export's per-frame alpha path.
    const [left, right] = splitStaticLayer(
      text({
        keyframes: [
          { tSec: 0, x: 0, y: 960, scale: 1 },
          { tSec: 10, x: 100, y: 960, scale: 1 }
        ]
      }),
      4,
      makeId
    )!
    expect(left.keyframes?.every((k) => !('opacity' in k))).toBe(true)
    expect(right.keyframes?.every((k) => !('opacity' in k))).toBe(true)
  })
})

describe('splitVideoLayer keyframes', () => {
  it('re-bases the right half so its motion does not restart at the cut', () => {
    const base = makeVideoLayer('a', 'm', 0, 10)
    const layer: Layer = {
      ...base,
      keyframes: [
        { tSec: 0, x: 0, y: 960, scale: 1 },
        { tSec: 10, x: 100, y: 960, scale: 1 }
      ]
    }
    const [left, right] = splitVideoLayer(layer, 4, () => 'new')!
    expect(left.keyframes?.at(-1)).toEqual({ tSec: 4, x: 40, y: 960, scale: 1 })
    expect(right.keyframes?.[0]).toEqual({ tSec: 0, x: 40, y: 960, scale: 1 })
    expect(layerTransformAt(left, 4)).toEqual(layerTransformAt(right, 4))
  })
  it('leaves a layer without keyframes alone', () => {
    const [left, right] = splitVideoLayer(makeVideoLayer('a', 'm', 0, 10), 4, () => 'new')!
    expect(left.keyframes).toBeUndefined()
    expect(right.keyframes).toBeUndefined()
  })
})

describe('splitCaptionSegment', () => {
  const makeId = (): string => 'new'
  const seg = (over: Partial<CaptionSegment> = {}): CaptionSegment => ({
    id: 'C1',
    startSec: 0,
    endSec: 4,
    text: 'one two three four',
    words: [
      { text: 'one', startSec: 0, endSec: 1 },
      { text: 'two', startSec: 1, endSec: 2 },
      { text: 'three', startSec: 2, endSec: 3 },
      { text: 'four', startSec: 3, endSec: 4 }
    ],
    enabled: true,
    ...over
  })

  it('splits the words at the cut and rebuilds each half’s text', () => {
    const [left, right] = splitCaptionSegment(seg(), 2, makeId)!
    expect(left).toMatchObject({ startSec: 0, endSec: 2, text: 'one two' })
    expect(right).toMatchObject({ id: 'new', startSec: 2, endSec: 4, text: 'three four' })
    expect(left.words.map((w) => w.text)).toEqual(['one', 'two'])
    expect(right.words.map((w) => w.text)).toEqual(['three', 'four'])
  })

  it('gives a word straddling the cut to the side holding more of it', () => {
    const [left, right] = splitCaptionSegment(seg(), 1.6, makeId)! // 'two' spans 1..2
    expect(left.words.map((w) => w.text)).toEqual(['one', 'two'])
    expect(right.words.map((w) => w.text)).toEqual(['three', 'four'])
  })

  it('keeps the full text on both halves when there are no word timings', () => {
    const [left, right] = splitCaptionSegment(seg({ words: [] }), 2, makeId)!
    expect(left.text).toBe('one two three four')
    expect(right.text).toBe('one two three four')
  })

  it('refuses to split at or outside the span', () => {
    expect(splitCaptionSegment(seg(), 0, makeId)).toBeNull()
    expect(splitCaptionSegment(seg(), 4, makeId)).toBeNull()
    expect(splitCaptionSegment(seg({ startSec: 2, endSec: 5 }), 1, makeId)).toBeNull()
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
