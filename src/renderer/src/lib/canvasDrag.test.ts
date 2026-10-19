import { describe, expect, it } from 'vitest'
import { createEmptyProject, type Layer, type LayerKeyframe } from '@shared/project'
import { makeTextLayer, makeVideoLayer } from '@shared/layers'
import {
  dragKeyframe,
  dragMode,
  movedLayer,
  movedMotionEnd,
  resizedLayer,
  withCaptionStyle,
  type DragKeyframe
} from './canvasDrag'

const video = (keyframes?: LayerKeyframe[]): Layer => ({ ...makeVideoLayer('V', 'm', 0, 4), keyframes })
const kf = (tSec: number, x: number, y: number, scale = 1, opacity?: number): LayerKeyframe => ({
  tSec,
  x,
  y,
  scale,
  ...(opacity !== undefined ? { opacity } : {})
})
const simpleMove = [kf(0, 100, 100), kf(2, 500, 900)]
const threeKfs = [kf(0, 100, 100), kf(1, 300, 300), kf(2, 500, 500)]
const at1: DragKeyframe = { tSec: 1, scale: 1, extra: {} }

describe('dragMode', () => {
  it('a layer without keyframes moves its base transform', () => {
    expect(dragMode(video(), video())).toBe('base')
  })
  it('a simple two-keyframe move moves as a path', () => {
    expect(dragMode(video(simpleMove), video(simpleMove))).toBe('path')
  })
  it('other keyframes get a keyframe at the playhead', () => {
    expect(dragMode(video(threeKfs), video(threeKfs))).toBe('keyframe')
  })
  it('text with any keyframes follows its path', () => {
    const t = { ...makeTextLayer('T', 0, 4), keyframes: threeKfs }
    expect(dragMode(t, t)).toBe('path')
  })
})

describe('dragKeyframe', () => {
  it('is the offset into the layer (clamped to it) and the scale there', () => {
    const l = { ...video(threeKfs), startSec: 2 }
    expect(dragKeyframe(l, 3)).toMatchObject({ tSec: 1, extra: {} })
    expect(dragKeyframe(l, 0).tSec).toBe(0)
    expect(dragKeyframe(l, 99).tSec).toBe(2) // the layer runs 2..4s
  })
  it('keeps a fade in effect there (full opacity is absence)', () => {
    const l = video([kf(0, 540, 960, 1, 0), kf(2, 540, 960, 1)])
    expect(dragKeyframe(l, 1).extra).toEqual({ opacity: 0.5 })
    expect(dragKeyframe(l, 2).extra).toEqual({})
  })
})

describe('movedLayer', () => {
  it('base: the centre goes to the pointer', () => {
    const l = video()
    expect(movedLayer(l, l, l, 'base', 600, 700, at1)).toMatchObject({ x: 600, y: 700 })
  })
  it('keyframe: writes the position at the playhead, base untouched', () => {
    const l = video(threeKfs)
    const out = movedLayer(l, l, l, 'keyframe', 333, 444, { tSec: 1, scale: 1.5, extra: { opacity: 0.4 } })
    expect(out.x).toBe(l.x)
    expect(out.keyframes).toContainEqual({ tSec: 1, x: 333, y: 444, scale: 1.5, opacity: 0.4 })
    expect(out.keyframes).toHaveLength(3) // replaced the one at t=1
  })
  it('path: base and every keyframe shift by the same delta', () => {
    const raw = { ...video(simpleMove), x: 100, y: 100 }
    const effective = { ...raw, x: 300, y: 500 } // mid-move
    const out = movedLayer(raw, effective, raw, 'path', 310, 520, at1)
    expect(out).toMatchObject({ x: 110, y: 120 })
    expect(out.keyframes!.map((k) => [k.x, k.y])).toEqual([
      [110, 120],
      [510, 920]
    ])
  })
})

describe('resizedLayer', () => {
  const box = { w: 200, h: 400 }
  it('a corner scales uniformly about the moved centre, clamped', () => {
    const l = { ...video(), scale: 1 }
    expect(resizedLayer(l, l, l, 'base', 'se', box, { w: 300, h: 600 }, 560, 980, at1)).toMatchObject({
      scale: 1.5,
      x: 560,
      y: 980
    })
    expect(resizedLayer(l, l, l, 'base', 'se', box, { w: 2000, h: 4000 }, 0, 0, at1).scale).toBe(8)
  })
  it('a corner on a keyframed layer writes a keyframe at the playhead', () => {
    const l = video(threeKfs)
    const out = resizedLayer(l, l, l, 'keyframe', 'nw', box, { w: 100, h: 200 }, 50, 60, {
      tSec: 1,
      extra: {}
    })
    expect(out.scale).toBe(l.scale)
    expect(out.keyframes).toContainEqual({ tSec: 1, x: 50, y: 60, scale: 0.5 })
  })
  it('a corner on a path scales the keyframes, keeping the base scale of media', () => {
    const raw = { ...video([kf(0, 100, 100, 1), kf(2, 500, 900, 2)]), x: 100, y: 100, scale: 1 }
    const out = resizedLayer(raw, raw, raw, 'path', 'se', box, { w: 400, h: 800 }, 100, 100, at1)
    expect(out.scale).toBe(1)
    expect(out.keyframes!.map((k) => k.scale)).toEqual([2, 4])
  })
  it('a side handle stretches media on its own axis', () => {
    const l = video()
    expect(resizedLayer(l, l, l, 'base', 'e', box, { w: 300, h: 400 }, 600, 960, at1)).toMatchObject({
      stretchX: 1.5,
      x: 600
    })
    expect(resizedLayer(l, l, l, 'base', 'n', box, { w: 200, h: 200 }, 540, 1000, at1).stretchY).toBe(0.5)
  })
  it('a side handle on text sets the (pre-scale) wrap width', () => {
    const t = { ...makeTextLayer('T', 0, 4), scale: 2 }
    const out = resizedLayer(t, t, t, 'base', 'w', box, { w: 600, h: 400 }, 540, 600, at1)
    expect(out.content.kind === 'text' && out.content.widthPx).toBe(300)
    expect(out.stretchX).toBeUndefined()
  })
})

describe('movedMotionEnd', () => {
  it('moves one end of a simple move; the other end and both times stay', () => {
    const unsorted = [simpleMove[1], simpleMove[0]]
    expect(movedMotionEnd(unsorted, 1, 10, -20)).toEqual([kf(0, 100, 100), kf(2, 510, 880)])
    expect(movedMotionEnd(unsorted, 0, 5, 5)).toEqual([kf(0, 105, 105), kf(2, 500, 900)])
  })
})

describe('withCaptionStyle', () => {
  const captions = {
    ...createEmptyProject('p', 'P').captions,
    segments: [
      { id: 'A', startSec: 0, endSec: 1, text: 'a', words: [], enabled: true },
      { id: 'B', startSec: 1, endSec: 2, text: 'b', words: [], enabled: true }
    ]
  }
  it('lane-wide: edits the lane style, segments untouched', () => {
    const out = withCaptionStyle(captions, 'A', true, { x: 10, y: 20 })
    expect(out.style).toMatchObject({ x: 10, y: 20 })
    expect(out.segments).toBe(captions.segments)
  })
  it('one caption: an override seeded from the lane style; others untouched', () => {
    const out = withCaptionStyle(captions, 'A', false, { rotationDeg: 15 })
    expect(out.style).toBe(captions.style)
    expect(out.segments[0].style).toEqual({ ...captions.style, rotationDeg: 15 })
    expect(out.segments[1]).toBe(captions.segments[1])
  })
})
