import { describe, it, expect } from 'vitest'
import type { Layer, LayerTransition } from './project'
import { makeImageLayer, makeTextLayer, makeVideoLayer, opacityKeyframePoints } from './layers'
import {
  clampTransitionSec,
  inRampAt,
  layerOpacityAt,
  layerOpacityPoints,
  maxTransitionSec,
  outRampAt,
  pairOf,
  platesUnderAt,
  splitTransitions,
  transitionGainAt,
  transitionPairs,
  transitionPlates,
  TRANSITION_MAX_SEC,
  TRANSITION_MIN_SEC,
  withTransition
} from './transitions'

const tr = (kind: LayerTransition['kind'], sec: number): LayerTransition => ({ kind, sec })
const video = (id: string, start: number, end: number, patch: Partial<Layer> = {}): Layer => ({
  ...makeVideoLayer(id, 'm', start, end - start),
  ...patch
})
/** Linear interpolation of export points at `t` (what sendcmd's lerp intervals do). */
function lerpPoints(pts: { t: number; o: number }[], t: number): number {
  if (t <= pts[0].t) return pts[0].o
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (t <= b.t) return b.t - a.t > 0 ? a.o + ((b.o - a.o) * (t - a.t)) / (b.t - a.t) : b.o
  }
  return pts[pts.length - 1].o
}

describe('ramps per kind', () => {
  it('fade and dissolve IN rise 0 → 1 over the window', () => {
    for (const kind of ['fade', 'dissolve'] as const) {
      expect(inRampAt(tr(kind, 0.5), 2, 2)).toBe(0)
      expect(inRampAt(tr(kind, 0.5), 2, 2.25)).toBeCloseTo(0.5)
      expect(inRampAt(tr(kind, 0.5), 2, 2.5)).toBe(1)
      expect(inRampAt(tr(kind, 0.5), 2, 1)).toBe(0)
      expect(inRampAt(tr(kind, 0.5), 2, 9)).toBe(1)
    }
  })

  it('a fade OUT falls 1 → 0; a dissolve OUT stays at full strength (the incoming clip fades over it)', () => {
    expect(outRampAt(tr('fade', 0.5), 5, 4.5)).toBe(1)
    expect(outRampAt(tr('fade', 0.5), 5, 4.75)).toBeCloseTo(0.5)
    expect(outRampAt(tr('fade', 0.5), 5, 5)).toBe(0)
    for (const t of [4.5, 4.75, 4.99]) expect(outRampAt(tr('dissolve', 0.5), 5, t)).toBe(1)
  })

  it('a dip goes out over the first half and comes in over the second', () => {
    for (const kind of ['dipBlack', 'dipWhite'] as const) {
      // out: 1 → 0 over [end − sec, end − sec/2], then hidden
      expect(outRampAt(tr(kind, 1), 5, 4)).toBe(1)
      expect(outRampAt(tr(kind, 1), 5, 4.25)).toBeCloseTo(0.5)
      expect(outRampAt(tr(kind, 1), 5, 4.5)).toBe(0)
      expect(outRampAt(tr(kind, 1), 5, 4.9)).toBe(0)
      // in: hidden over [start, start + sec/2], then 0 → 1
      expect(inRampAt(tr(kind, 1), 4, 4.2)).toBe(0)
      expect(inRampAt(tr(kind, 1), 4, 4.5)).toBe(0)
      expect(inRampAt(tr(kind, 1), 4, 4.75)).toBeCloseTo(0.5)
      expect(inRampAt(tr(kind, 1), 4, 5)).toBe(1)
    }
  })
})

describe('layerOpacityAt — keyframed opacity × transition ramps', () => {
  it('is the keyframed opacity alone without transitions', () => {
    const l = video('a', 0, 4, { keyframes: [{ tSec: 0, x: 540, y: 960, scale: 1, opacity: 0.4 }] })
    expect(layerOpacityAt(l, 2)).toBeCloseTo(0.4)
    expect(layerOpacityAt(video('b', 0, 4), 2)).toBe(1)
  })

  it('multiplies the two', () => {
    const l = video('a', 2, 6, {
      transitionIn: tr('fade', 1),
      transitionOut: tr('fade', 1),
      keyframes: [
        { tSec: 0, x: 540, y: 960, scale: 1 },
        { tSec: 4, x: 540, y: 960, scale: 1, opacity: 0.2 }
      ]
    })
    for (const t of [2, 2.3, 2.5, 3, 4, 5.2, 5.6, 6]) {
      const kf = 1 - (0.8 * (t - 2)) / 4
      const ramp = Math.min(1, Math.max(0, t - 2)) * Math.min(1, Math.max(0, 6 - t))
      expect(layerOpacityAt(l, t)).toBeCloseTo(kf * ramp, 9)
    }
  })

  it('ignores transitions on a kind that does not take them (text)', () => {
    const l: Layer = { ...makeTextLayer('t', 0, 4), transitionIn: tr('fade', 1) }
    expect(transitionGainAt(l, 0.1)).toBe(1)
    expect(layerOpacityAt(l, 0.1)).toBe(1)
  })

  it('applies to image layers', () => {
    const l: Layer = { ...makeImageLayer('i', 'm', 0, 4), transitionOut: tr('fade', 2) }
    expect(layerOpacityAt(l, 3)).toBeCloseTo(0.5)
  })
})

describe('layerOpacityPoints — what the export interpolates', () => {
  it('is exactly opacityKeyframePoints without a transition (byte-identical export)', () => {
    const plain = video('a', 1, 5)
    expect(layerOpacityPoints(plain)).toBeNull()
    const kf = video('b', 1, 5, {
      keyframes: [
        { tSec: 0, x: 540, y: 960, scale: 1 },
        { tSec: 2, x: 540, y: 960, scale: 1, opacity: 0.5 }
      ]
    })
    expect(layerOpacityPoints(kf)).toEqual(opacityKeyframePoints(kf))
    // A dissolve OUT is no ramp, so the outgoing clip keeps its plain pipeline.
    expect(layerOpacityPoints(video('c', 1, 5, { transitionOut: tr('dissolve', 0.5) }))).toBeNull()
  })

  it('gives the corners of a fade / dissolve / dip', () => {
    expect(layerOpacityPoints(video('a', 2, 6, { transitionIn: tr('dissolve', 0.5) }))).toEqual([
      { t: 2, o: 0 },
      { t: 2.25, o: 0.5 },
      { t: 2.5, o: 1 },
      { t: 6, o: 1 }
    ])
    expect(layerOpacityPoints(video('a', 2, 6, { transitionOut: tr('dipWhite', 1) }))).toEqual([
      { t: 2, o: 1 },
      { t: 5, o: 1 },
      { t: 5.5, o: 0 },
      { t: 6, o: 0 }
    ])
  })

  it('tracks the product within 1/30 s sampling where both factors move', () => {
    const l = video('a', 2, 6, {
      transitionIn: tr('dissolve', 1),
      transitionOut: tr('dipBlack', 2),
      keyframes: [
        { tSec: 0.5, x: 540, y: 960, scale: 1, opacity: 0.9 },
        { tSec: 3.5, x: 540, y: 960, scale: 1, opacity: 0.1 }
      ]
    })
    const pts = layerOpacityPoints(l)!
    for (let t = 2; t <= 6; t += 0.01) {
      expect(Math.abs(lerpPoints(pts, t) - layerOpacityAt(l, t))).toBeLessThan(0.002)
    }
  })

  it('samples where the tile’s own in and out ramps overlap (a clip trimmed shorter than its fades)', () => {
    // A 2 s clip with a 1 s fade in and a 1 s fade out, its end trimmed by
    // 0.5 s (a trim leaves the transitions as they are): the ramps overlap
    // over [0.5, 1], where the product is quadratic.
    const full = video('a', 0, 2, { transitionIn: tr('fade', 1), transitionOut: tr('fade', 1) })
    const l = { ...full, endSec: full.endSec - 0.5 }
    expect(layerOpacityAt(l, 0.75)).toBeCloseTo(0.5625, 9) // the preview: 0.75 × 0.75
    const pts = layerOpacityPoints(l)!
    expect(Math.abs(lerpPoints(pts, 0.75) - 0.5625)).toBeLessThan(0.002) // the export
    for (let t = 0; t <= 1.5; t += 0.01) {
      expect(Math.abs(lerpPoints(pts, t) - layerOpacityAt(l, t))).toBeLessThan(0.002)
    }
  })
})

describe('pairs and plates', () => {
  // A ends at 4; B starts 0.5 earlier (they overlap by the transition).
  const pairOfKind = (kind: LayerTransition['kind']): Layer[] => [
    video('A', 0, 4, { transitionOut: tr(kind, 0.5) }),
    video('B', 3.5, 8, { transitionIn: tr(kind, 0.5) })
  ]

  it('pairs an outgoing and an incoming side of the same kind and length that overlap by it', () => {
    expect(transitionPairs(pairOfKind('dissolve'))).toEqual([{ outId: 'A', inId: 'B', kind: 'dissolve', sec: 0.5 }])
    expect(pairOf(pairOfKind('dipBlack'), 'A', 'out')?.inId).toBe('B')
    expect(pairOf(pairOfKind('dipBlack'), 'B', 'in')?.outId).toBe('A')
  })

  it('does not pair across a moved tile, a different kind or length, or a fade', () => {
    const [a, b] = pairOfKind('dissolve')
    expect(transitionPairs([a, { ...b, startSec: 3.3 }])).toEqual([])
    expect(transitionPairs([a, { ...b, transitionIn: tr('dipBlack', 0.5) }])).toEqual([])
    expect(transitionPairs([a, { ...b, transitionIn: tr('dissolve', 0.4) }])).toEqual([])
    expect(
      transitionPairs([
        { ...a, transitionOut: tr('fade', 0.5) },
        { ...b, transitionIn: tr('fade', 0.5) }
      ])
    ).toEqual([])
  })

  it('a dip pair puts ONE plate under the lower tile, for the whole window', () => {
    const [a, b] = pairOfKind('dipWhite')
    expect(transitionPlates([a, b])).toEqual([{ color: '#ffffff', startSec: 3.5, endSec: 4, belowId: 'A' }])
    // Reversed stack: under B, which is now the lower one.
    expect(transitionPlates([b, a])).toEqual([{ color: '#ffffff', startSec: 3.5, endSec: 4, belowId: 'B' }])
    expect(transitionPlates(pairOfKind('dissolve'))).toEqual([])
  })

  it('a lone dip side keeps a plate under its own tile; a hidden tile gives none', () => {
    const [a, b] = pairOfKind('dipBlack')
    expect(transitionPlates([a])).toEqual([{ color: '#000000', startSec: 3.5, endSec: 4, belowId: 'A' }])
    expect(transitionPlates([a, { ...b, hidden: true }])).toEqual([
      { color: '#000000', startSec: 3.5, endSec: 4, belowId: 'A' }
    ])
    expect(
      transitionPlates([
        { ...a, hidden: true },
        { ...b, hidden: true }
      ])
    ).toEqual([])
    const plates = transitionPlates([a, b])
    expect(platesUnderAt(plates, 'A', 3.7)).toHaveLength(1)
    expect(platesUnderAt(plates, 'A', 4)).toHaveLength(0)
    expect(platesUnderAt(plates, 'B', 3.7)).toHaveLength(0)
  })

  it('a paired dip goes through the colour: A out, plate, B in', () => {
    const [a, b] = pairOfKind('dipBlack')
    expect(layerOpacityAt(a, 3.5)).toBe(1)
    expect(layerOpacityAt(a, 3.75)).toBe(0)
    expect(layerOpacityAt(b, 3.75)).toBe(0)
    expect(layerOpacityAt(b, 4)).toBe(1)
  })
})

describe('length bounds and edits', () => {
  it('is never more than half the shorter tile, nor more than 2 s', () => {
    expect(maxTransitionSec(10, 3)).toBe(1.5)
    expect(maxTransitionSec(10, 10)).toBe(TRANSITION_MAX_SEC)
    expect(clampTransitionSec(5, 1.5)).toBe(1.5)
    expect(clampTransitionSec(0.01, 1.5)).toBe(TRANSITION_MIN_SEC)
  })

  it('withTransition removes the field outright (no undefined left behind)', () => {
    const l = video('a', 0, 4, { transitionIn: tr('fade', 1) })
    const cleared = withTransition(l, 'in', null)
    expect('transitionIn' in cleared).toBe(false)
    const plain = video('b', 0, 4)
    expect(withTransition(plain, 'out', null)).toBe(plain)
  })

  it('split: the left half keeps the transition in, the right half the transition out', () => {
    const l = video('a', 0, 4, { transitionIn: tr('dissolve', 0.5), transitionOut: tr('fade', 1) })
    const [left, right] = splitTransitions({ ...l, endSec: 2 }, { ...l, id: 'r', startSec: 2 })
    expect(left.transitionIn).toEqual(tr('dissolve', 0.5))
    expect('transitionOut' in left).toBe(false)
    expect(right.transitionOut).toEqual(tr('fade', 1))
    expect('transitionIn' in right).toBe(false)
  })
})
