import { describe, it, expect } from 'vitest'
import type { Layer } from './project'
import {
  applyVisibleOrder,
  hookCovered,
  isBackgroundId,
  layersAtTime,
  makeImageLayer,
  makeTextLayer,
  makeVideoLayer,
  moveLayer,
  videoSourceTime,
  visualDuration
} from './layers'

const vid = (id: string, start: number, end: number): Layer => ({
  ...makeVideoLayer(id, 'm', start, end - start)
})
const txt = (id: string, start: number, end: number, text = 'hi'): Layer => ({
  ...makeTextLayer(id, start, end),
  content: { kind: 'text', text, fontFamily: 'x', fontSizePx: 40, color: '#fff', pill: { enabled: false, color: '#000', padPx: 0 } }
})

describe('layersAtTime', () => {
  const a = vid('a', 0, 2)
  const b = txt('b', 1.5, 5)
  it('returns layers whose window contains t, in stack order', () => {
    expect(layersAtTime([a, b], 1).map((l) => l.id)).toEqual(['a'])
    expect(layersAtTime([a, b], 1.7).map((l) => l.id)).toEqual(['a', 'b'])
    expect(layersAtTime([a, b], 4).map((l) => l.id)).toEqual(['b'])
    expect(layersAtTime([a, b], 9)).toEqual([])
  })
  it('end is exclusive', () => {
    expect(layersAtTime([a], 2)).toEqual([])
  })
})

describe('visualDuration', () => {
  it('is the furthest endSec across the stack', () => {
    expect(visualDuration([vid('a', 0, 2), txt('b', 1, 7)])).toBe(7)
    expect(visualDuration([])).toBe(0)
  })
})

describe('videoSourceTime', () => {
  it('maps timeline time to source time within the trim', () => {
    const l = makeVideoLayer('a', 'm', 4, 10) // startSec 4, in 0, out 10
    const c = l.content as Extract<Layer['content'], { kind: 'video' }>
    expect(videoSourceTime(c, l, 4)).toBe(0)
    expect(videoSourceTime(c, l, 6)).toBe(2)
    expect(videoSourceTime(c, l, 100)).toBe(10) // clamped to outSec
    expect(videoSourceTime(c, l, 0)).toBe(0) // clamped to inSec
  })
})

describe('isBackgroundId', () => {
  it('only the bottom (index 0) layer is the background', () => {
    const layers = [vid('a', 0, 2), txt('b', 0, 2)]
    expect(isBackgroundId(layers, 'a')).toBe(true)
    expect(isBackgroundId(layers, 'b')).toBe(false)
    expect(isBackgroundId([], 'a')).toBe(false)
  })
})

describe('applyVisibleOrder', () => {
  // Full stack a,b,c,d (back→front). At some time only a, c, d are visible (b hidden by time).
  const layers = [vid('a', 0, 9), vid('b', 5, 9), txt('c', 0, 9), txt('d', 0, 9)]
  it('reorders visible layers while pinning non-visible ones to their slots', () => {
    // New visible order back→front: c, a, d (was a, c, d). b stays in its slot (index 1).
    const next = applyVisibleOrder(layers, ['c', 'a', 'd'])
    expect(next.map((l) => l.id)).toEqual(['c', 'b', 'a', 'd'])
  })
  it('is a no-op when the order is unchanged', () => {
    const next = applyVisibleOrder(layers, ['a', 'c', 'd'])
    expect(next.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('moveLayer', () => {
  const layers = [vid('a', 0, 1), vid('b', 0, 1), vid('c', 0, 1)]
  it('moves a layer to a new index', () => {
    expect(moveLayer(layers, 2, 0).map((l) => l.id)).toEqual(['c', 'a', 'b'])
    expect(moveLayer(layers, 0, 2).map((l) => l.id)).toEqual(['b', 'c', 'a'])
  })
  it('guards out-of-range / no-op', () => {
    expect(moveLayer(layers, 1, 1)).toBe(layers)
    expect(moveLayer(layers, -1, 0)).toBe(layers)
  })
})

describe('hookCovered', () => {
  it('true when a non-empty text layer is on screen in the first 3s', () => {
    expect(hookCovered([txt('a', 0, 2)])).toBe(true)
    expect(hookCovered([txt('a', 2.9, 6)])).toBe(true)
  })
  it('false when the first text starts at/after 3s, or is empty, or there is none', () => {
    expect(hookCovered([txt('a', 3, 6)])).toBe(false)
    expect(hookCovered([txt('a', 0, 3, '   ')])).toBe(false)
    expect(hookCovered([vid('a', 0, 3)])).toBe(false)
    expect(hookCovered([])).toBe(false)
  })
})

describe('factories', () => {
  it('center the layer and set a sensible time window', () => {
    const v = makeVideoLayer('v', 'm', 1, 4)
    expect(v.x).toBe(540)
    expect(v.y).toBe(960)
    expect(v.endSec).toBe(5)
    expect(v.content.kind).toBe('video')

    const i = makeImageLayer('i', 'm', 2, 5)
    expect(i.scale).toBe(0.5)
    expect(i.content.kind).toBe('image')

    const t = makeTextLayer('t', 0, 3)
    expect(t.content.kind).toBe('text')
    expect(t.y).toBeCloseTo(1920 * 0.32, 5)
  })
})
