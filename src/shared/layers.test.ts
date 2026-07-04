import { describe, it, expect } from 'vitest'
import type { Layer } from './project'
import {
  applyVisibleOrder,
  containBox,
  effectiveImageAspect,
  FRAME,
  freezeExtraSec,
  hookCovered,
  isBackgroundId,
  isFrozenAt,
  layersAtTime,
  makeImageLayer,
  makeTextLayer,
  makeVideoLayer,
  moveLayer,
  resizeBox,
  stretchedBox,
  videoSourceTime,
  visualDuration
} from './layers'
import type { VideoContent } from './project'

const vid = (id: string, start: number, end: number): Layer => ({
  ...makeVideoLayer(id, 'm', start, end - start)
})
const txt = (id: string, start: number, end: number, text = 'hi'): Layer => ({
  ...makeTextLayer(id, start, end),
  content: { kind: 'text', text, fontFamily: 'x', fontSizePx: 40, color: '#fff', pill: { enabled: false, color: '#000', padPx: 0 } }
})

describe('containBox', () => {
  it('a tall (frame-aspect) source fills the whole frame at scale 1', () => {
    expect(containBox(FRAME.width / FRAME.height, 1)).toEqual({ w: FRAME.width, h: FRAME.height })
  })
  it('a wide source fills the width and letterboxes the height', () => {
    expect(containBox(2, 1)).toEqual({ w: 1080, h: 540 })
  })
  it('scale multiplies both dimensions', () => {
    expect(containBox(2, 0.5)).toEqual({ w: 540, h: 270 })
  })
  it('honors a custom (output) frame', () => {
    expect(containBox(1, 1, { width: 1080, height: 1080 })).toEqual({ w: 1080, h: 1080 })
  })
})

describe('stretchedBox', () => {
  it('equals containBox when stretch is 1', () => {
    expect(stretchedBox(2, 1, 1, 1)).toEqual(containBox(2, 1))
  })
  it('multiplies each axis by its stretch independently (distortion)', () => {
    expect(stretchedBox(2, 1, 1.5, 0.5)).toEqual({ w: 1620, h: 270 })
  })
  it('defaults stretch to 1', () => {
    expect(stretchedBox(2, 0.5)).toEqual({ w: 540, h: 270 })
  })
})

describe('resizeBox', () => {
  const box = { cx: 100, cy: 100, w: 40, h: 20 } // edges at x:80..120, y:90..110

  it('east edge: widens right, left edge stays fixed, center shifts by dx/2', () => {
    const r = resizeBox(box, 'e', 10, 0, false)
    expect(r).toEqual({ cx: 105, cy: 100, w: 50, h: 20 })
    expect(r.cx - r.w / 2).toBe(80) // left edge unmoved
  })
  it('west edge: dragging right narrows, right edge stays fixed', () => {
    const r = resizeBox(box, 'w', 10, 0, false)
    expect(r).toEqual({ cx: 105, cy: 100, w: 30, h: 20 })
    expect(r.cx + r.w / 2).toBe(120) // right edge unmoved
  })
  it('south edge only touches the vertical axis', () => {
    const r = resizeBox(box, 's', 0, 8, false)
    expect(r).toEqual({ cx: 100, cy: 104, w: 40, h: 28 })
  })
  it('clamps to minSize instead of inverting', () => {
    const r = resizeBox(box, 'e', -1000, 0, false, 8)
    expect(r.w).toBe(8)
    expect(r.cx - r.w / 2).toBe(80) // still anchored to the left edge
  })
  it('corner scales both dims uniformly, anchored at the opposite corner', () => {
    // Grab SE corner; a drag purely along +x projects onto the diagonal.
    const r = resizeBox({ cx: 0, cy: 0, w: 40, h: 20 }, 'se', 20, 10, true)
    const f = r.w / 40
    expect(r.h / 20).toBeCloseTo(f) // aspect preserved
    // opposite (NW) corner fixed at (-20, -10)
    expect(r.cx - r.w / 2).toBeCloseTo(-20)
    expect(r.cy - r.h / 2).toBeCloseTo(-10)
  })
})

describe('effectiveImageAspect', () => {
  it('passes the base aspect through when no crop/rotation', () => {
    expect(effectiveImageAspect(1.5, null, 0)).toBe(1.5)
  })
  it('reshapes by a 0..1 crop', () => {
    expect(effectiveImageAspect(1, { w: 0.5, h: 1 }, 0)).toBe(0.5)
  })
  it('inverts the aspect for 90°/270° rotation', () => {
    expect(effectiveImageAspect(2, null, 1)).toBe(0.5)
    expect(effectiveImageAspect(2, null, 3)).toBe(0.5)
    expect(effectiveImageAspect(2, null, 2)).toBe(2)
  })
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

  it('holds the source frame across a freeze, then resumes', () => {
    // startSec 0, in 0, out 10; freeze at source 3s for 2s.
    const l = makeVideoLayer('a', 'm', 0, 10)
    const c = { ...(l.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
    expect(videoSourceTime(c, l, 2)).toBe(2) // before the freeze: linear
    expect(videoSourceTime(c, l, 3)).toBe(3) // freeze begins
    expect(videoSourceTime(c, l, 4)).toBe(3) // mid-hold: frozen
    expect(videoSourceTime(c, l, 4.99)).toBe(3) // still held
    expect(videoSourceTime(c, l, 5)).toBe(3) // hold ends; resumes at source 3
    expect(videoSourceTime(c, l, 6)).toBe(4) // 1s after resume → source 4
  })

  it('chains multiple freezes', () => {
    const l = makeVideoLayer('a', 'm', 0, 10)
    const c = { ...(l.content as VideoContent), freezes: [{ atSec: 2, holdSec: 1 }, { atSec: 5, holdSec: 2 }] }
    expect(videoSourceTime(c, l, 2.5)).toBe(2) // inside first hold
    expect(videoSourceTime(c, l, 4)).toBe(3) // after first hold (1s dead time removed)
    expect(videoSourceTime(c, l, 6)).toBe(5) // inside second hold (2+3 dead... at played 6: source 5)
    expect(videoSourceTime(c, l, 9)).toBe(6) // both holds (3s) removed
  })
})

describe('freezeExtraSec / isFrozenAt', () => {
  const l = makeVideoLayer('a', 'm', 0, 10)
  const c = { ...(l.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
  it('sums holds and detects the hold window', () => {
    expect(freezeExtraSec(c)).toBe(2)
    expect(freezeExtraSec(l.content as VideoContent)).toBe(0)
    expect(isFrozenAt(c, l, 2.9)).toBe(false)
    expect(isFrozenAt(c, l, 3.5)).toBe(true)
    expect(isFrozenAt(c, l, 5)).toBe(false)
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
