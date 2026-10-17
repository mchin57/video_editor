import { describe, it, expect } from 'vitest'
import type { Layer } from './project'
import {
  applyVisibleOrder,
  centeredFrame,
  containBox,
  effectiveImageAspect,
  fitScale,
  FRAME,
  frameToOutput,
  freezeExtraSec,
  FULL_FRAME,
  hookCovered,
  isBackgroundId,
  isFrozenAt,
  layerFitScale,
  layersAtTime,
  layerTransformAt,
  makeImageLayer,
  makeTextLayer,
  makeVideoLayer,
  moveLayer,
  opacityKeyframePoints,
  playedVideoDuration,
  rebaseVideoContent,
  rescaleForAspect,
  resizeBox,
  stretchedBox,
  upsertKeyframe,
  videoSourceTime,
  videoSourceWindow,
  videoTimelineTime,
  visualDuration,
  windowCoversVideo
} from './layers'
import type { VideoContent } from './project'

const vid = (id: string, start: number, end: number): Layer => ({
  ...makeVideoLayer(id, 'm', start, end - start)
})
const txt = (id: string, start: number, end: number, text = 'hi'): Layer => ({
  ...makeTextLayer(id, start, end),
  content: {
    kind: 'text',
    text,
    fontFamily: 'x',
    fontSizePx: 40,
    color: '#fff',
    pill: { enabled: false, color: '#000', padPx: 0 }
  }
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
    const c = {
      ...(l.content as VideoContent),
      freezes: [
        { atSec: 2, holdSec: 1 },
        { atSec: 5, holdSec: 2 }
      ]
    }
    expect(videoSourceTime(c, l, 2.5)).toBe(2) // inside first hold
    expect(videoSourceTime(c, l, 4)).toBe(3) // after first hold (1s dead time removed)
    expect(videoSourceTime(c, l, 6)).toBe(5) // inside second hold (2+3 dead... at played 6: source 5)
    expect(videoSourceTime(c, l, 9)).toBe(6) // both holds (3s) removed
  })
})

describe('videoSourceTime with speed', () => {
  it('advances source time at the clip speed', () => {
    const l = makeVideoLayer('a', 'm', 4, 10)
    const c = { ...(l.content as VideoContent), speed: 2 }
    expect(videoSourceTime(c, l, 4)).toBe(0)
    expect(videoSourceTime(c, l, 6)).toBe(4) // 2 played s × 2 = source 4
    const slow = { ...(l.content as VideoContent), speed: 0.5 }
    expect(videoSourceTime(slow, l, 6)).toBe(1) // 2 played s × 0.5 = source 1
  })

  it('keeps freeze holds wall-clock and thresholds in source time', () => {
    // in 0, out 10, speed 2: freeze at source 4 begins at played 2, holds 3s.
    const l = makeVideoLayer('a', 'm', 0, 10)
    const c = { ...(l.content as VideoContent), speed: 2, freezes: [{ atSec: 4, holdSec: 3 }] }
    expect(videoSourceTime(c, l, 1)).toBe(2) // before the hold: 2× mapping
    expect(videoSourceTime(c, l, 2.5)).toBe(4) // inside the hold
    expect(isFrozenAt(c, l, 2.5)).toBe(true)
    expect(videoSourceTime(c, l, 5)).toBe(4) // hold ends at played 5
    expect(videoSourceTime(c, l, 6)).toBe(6) // 1s after resume → +2 source s
    expect(isFrozenAt(c, l, 6)).toBe(false)
  })
})

describe('videoSourceTime with a speed ramp', () => {
  // in 0, out 4; speed ramps 1 → 2 across the whole clip. The played window is
  // 4·ln(2) ≈ 2.7726 s; the closed-form inverse is s(p) = 4·(e^(p/4) − 1).
  const l = makeVideoLayer('a', 'm', 1, 4)
  const ramp = [
    { atSec: 0, speed: 1 },
    { atSec: 4, speed: 2 }
  ]
  const c = { ...(l.content as VideoContent), outSec: 4, speedRamp: ramp }

  it('follows the log-integral mapping (ramp overrides the constant speed)', () => {
    expect(videoSourceTime({ ...c, speed: 4 }, l, 1)).toBe(0)
    expect(videoSourceTime(c, l, 2)).toBeCloseTo(4 * (Math.exp(0.25) - 1), 9)
    expect(videoSourceTime(c, l, 1 + 4 * Math.log(2))).toBeCloseTo(4, 9)
    expect(videoSourceTime(c, l, 100)).toBe(4) // clamped to outSec
  })

  it('keeps freeze holds wall-clock with source-time thresholds under a ramp', () => {
    // Freeze at source 2: begins at played 4·ln(1.5), holds 1 s.
    const cf = { ...c, freezes: [{ atSec: 2, holdSec: 1 }] }
    const holdStart = 1 + 4 * Math.log(1.5)
    expect(videoSourceTime(cf, l, holdStart + 0.5)).toBe(2) // mid-hold
    expect(isFrozenAt(cf, l, holdStart + 0.5)).toBe(true)
    expect(videoSourceTime(cf, l, holdStart + 1.001)).toBeCloseTo(2, 2) // just resumed
    expect(isFrozenAt(cf, l, holdStart + 1.001)).toBe(false)
    expect(playedVideoDuration(cf)).toBeCloseTo(4 * Math.log(2) + 1, 9)
  })
})

describe('videoTimelineTime', () => {
  it('inverts videoSourceTime (freeze holds land at the hold start)', () => {
    const l = makeVideoLayer('a', 'm', 3, 10)
    const c = {
      ...(l.content as VideoContent),
      speed: 2,
      freezes: [{ atSec: 4, holdSec: 3 }]
    }
    expect(videoTimelineTime(c, l, 0)).toBe(3)
    expect(videoTimelineTime(c, l, 2)).toBe(4) // 2 source s at 2× = 1 played s
    expect(videoTimelineTime(c, l, 4)).toBe(5) // the hold's start
    expect(videoTimelineTime(c, l, 6)).toBe(9) // past the hold: +3 wall-clock
    // Round-trip through videoSourceTime away from the hold.
    expect(videoSourceTime(c, l, videoTimelineTime(c, l, 7))).toBeCloseTo(7, 9)
  })
})

describe('playedVideoDuration', () => {
  const l = makeVideoLayer('a', 'm', 0, 10)
  it('is source span / speed + wall-clock holds', () => {
    const c = l.content as VideoContent
    expect(playedVideoDuration(c)).toBe(10)
    expect(playedVideoDuration({ ...c, speed: 2 })).toBe(5)
    expect(playedVideoDuration({ ...c, speed: 0.5 })).toBe(20)
    expect(playedVideoDuration({ ...c, speed: 2, freezes: [{ atSec: 3, holdSec: 2 }] })).toBe(7)
  })
  it('integrates a speed ramp', () => {
    const c = {
      ...(l.content as VideoContent),
      outSec: 4,
      speedRamp: [
        { atSec: 0, speed: 1 },
        { atSec: 4, speed: 2 }
      ]
    }
    expect(playedVideoDuration(c)).toBeCloseTo(4 * Math.log(2), 9)
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

describe('layerTransformAt / upsertKeyframe', () => {
  const base = { ...makeVideoLayer('a', 'm', 2, 10) } // startSec 2
  it('returns the base transform without keyframes', () => {
    expect(layerTransformAt(base, 5)).toEqual({ x: base.x, y: base.y, scale: base.scale, opacity: 1 })
  })
  it('holds before the first and after the last keyframe', () => {
    const l = {
      ...base,
      keyframes: [
        { tSec: 1, x: 100, y: 200, scale: 1 },
        { tSec: 3, x: 300, y: 400, scale: 2 }
      ]
    }
    expect(layerTransformAt(l, 2)).toEqual({ x: 100, y: 200, scale: 1, opacity: 1 }) // t=2 → local 0 < 1
    expect(layerTransformAt(l, 9)).toEqual({ x: 300, y: 400, scale: 2, opacity: 1 }) // local 7 > 3
  })
  it('lerps linearly between keyframes', () => {
    const l = {
      ...base,
      keyframes: [
        { tSec: 1, x: 100, y: 200, scale: 1 },
        { tSec: 3, x: 300, y: 400, scale: 2 }
      ]
    }
    // t=4 → local 2 → halfway between tSec 1 and 3.
    expect(layerTransformAt(l, 4)).toEqual({ x: 200, y: 300, scale: 1.5, opacity: 1 })
  })
  it('a single keyframe pins the transform', () => {
    const l = { ...base, keyframes: [{ tSec: 1, x: 50, y: 60, scale: 0.5 }] }
    expect(layerTransformAt(l, 2)).toEqual({ x: 50, y: 60, scale: 0.5, opacity: 1 })
    expect(layerTransformAt(l, 9)).toEqual({ x: 50, y: 60, scale: 0.5, opacity: 1 })
  })
  it('upsert replaces a keyframe within epsilon and keeps the list sorted', () => {
    const kfs = [
      { tSec: 0, x: 1, y: 1, scale: 1 },
      { tSec: 2, x: 2, y: 2, scale: 1 }
    ]
    const replaced = upsertKeyframe(kfs, { tSec: 2.01, x: 9, y: 9, scale: 2 })
    expect(replaced).toHaveLength(2)
    expect(replaced[1]).toEqual({ tSec: 2.01, x: 9, y: 9, scale: 2 })
    const inserted = upsertKeyframe(kfs, { tSec: 1, x: 5, y: 5, scale: 1 })
    expect(inserted.map((k) => k.tSec)).toEqual([0, 1, 2])
    expect(upsertKeyframe(undefined, { tSec: 0.5, x: 1, y: 1, scale: 1 })).toHaveLength(1)
  })
})

describe('keyframed opacity', () => {
  const base = { ...makeVideoLayer('a', 'm', 2, 10) } // startSec 2
  it('interpolates opacity between keyframes, defaulting absent to 1', () => {
    const l: Layer = {
      ...base,
      keyframes: [
        { tSec: 0, x: 0, y: 0, scale: 1 }, // no opacity → 1
        { tSec: 2, x: 0, y: 0, scale: 1, opacity: 0.4 }
      ]
    }
    expect(layerTransformAt(l, 2).opacity).toBe(1)
    expect(layerTransformAt(l, 3).opacity).toBeCloseTo(0.7, 9)
    expect(layerTransformAt(l, 4).opacity).toBeCloseTo(0.4, 9)
    expect(layerTransformAt(l, 99).opacity).toBeCloseTo(0.4, 9) // holds after
    expect(layerTransformAt({ ...base, keyframes: undefined }, 3).opacity).toBe(1)
  })

  it('opacityKeyframePoints: absolute times; null when nothing fades', () => {
    const l: Layer = {
      ...base,
      keyframes: [
        { tSec: 0, x: 0, y: 0, scale: 1 },
        { tSec: 2, x: 0, y: 0, scale: 1, opacity: 0.4 }
      ]
    }
    expect(opacityKeyframePoints(l)).toEqual([
      { t: 2, o: 1 },
      { t: 4, o: 0.4 }
    ])
    // All keyframes fully opaque → null (keep the plain opaque pipeline).
    const still: Layer = { ...base, keyframes: [{ tSec: 0, x: 0, y: 0, scale: 1 }] }
    expect(opacityKeyframePoints(still)).toBeNull()
    expect(opacityKeyframePoints({ ...base, keyframes: undefined })).toBeNull()
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

  it('fit new media to the frame it is placed in', () => {
    const frame = centeredFrame(1920, 1080)
    // A 16:9 clip in a 16:9 frame fills it exactly…
    const v = makeVideoLayer('v', 'm', 0, 4, { frame, aspect: 16 / 9 })
    expect(stretchedBox(16 / 9, v.scale).w).toBeCloseTo(1920, 6)
    // …a phone clip pillarboxes to the frame height.
    const p = makeVideoLayer('p', 'm', 0, 4, { frame, aspect: 9 / 16 })
    expect(stretchedBox(9 / 16, p.scale).h).toBeCloseTo(1080, 6)
    // Images start at half of that fit; text a third of the way down the frame.
    expect(makeImageLayer('i', 'm', 0, 3, { frame, aspect: 16 / 9 }).scale).toBeCloseTo(v.scale / 2, 9)
    expect(makeTextLayer('t', 0, 3, frame).y).toBeCloseTo(420 + 1080 * 0.32, 9)
    // Unknown aspect (or the 9:16 frame) keeps the old defaults.
    expect(makeVideoLayer('u', 'm', 0, 4, { frame }).scale).toBe(1)
    expect(makeVideoLayer('r', 'm', 0, 4, { aspect: 16 / 9 }).scale).toBe(1)
  })
})

describe('output frame', () => {
  it('centers a format window on the canonical space; 9:16 is the identity', () => {
    expect(FULL_FRAME).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
    expect(centeredFrame(1080, 1080)).toEqual({ x: 0, y: 420, w: 1080, h: 1080 })
    expect(centeredFrame(1920, 1080)).toEqual({ x: -420, y: 420, w: 1920, h: 1080 })
  })

  it('maps canonical coords into output px uniformly, frame top-left → (0,0)', () => {
    const m = frameToOutput(centeredFrame(1920, 1080), 1920)
    expect(m.s).toBe(1)
    expect([m.x(-420), m.y(420)]).toEqual([0, 0])
    expect([m.x(540), m.y(960)]).toEqual([960, 540]) // canonical center = frame center
    const half = frameToOutput(FULL_FRAME, 540)
    expect([half.s, half.x(1080), half.y(1920)]).toEqual([0.5, 540, 960])
  })

  it('fitScale is 1 in the 9:16 frame and converts elsewhere', () => {
    expect(fitScale(16 / 9)).toBe(1)
    expect(fitScale(9 / 16, centeredFrame(1080, 1080))).toBeCloseTo(0.5625, 9)
    expect(fitScale(16 / 9, centeredFrame(1920, 1080))).toBeCloseTo(1920 / 1080, 9)
    expect(fitScale(1, centeredFrame(1080, 1080))).toBe(1)
  })

  it('layerFitScale: the 100% zoom per layer kind', () => {
    const wide = centeredFrame(1920, 1080)
    const video = makeVideoLayer('v', 'm', 0, 2)
    expect(layerFitScale(video, 9 / 16, FULL_FRAME)).toBe(1)
    expect(layerFitScale(video, 9 / 16, wide)).toBeCloseTo(0.5625, 9)
    // A crop wins over the source aspect.
    const cropped = { ...video, content: { ...(video.content as VideoContent), crop: { x: 0, y: 0, w: 1600, h: 900 } } }
    expect(layerFitScale(cropped, 9 / 16, wide)).toBeCloseTo(1920 / 1080, 9)
    // An image rotated a quarter turn fits by its swapped aspect.
    const img = makeImageLayer('i', 'm', 0, 2)
    const rotated = { ...img, content: { kind: 'image' as const, mediaId: 'm', opacity: 1, rotateQuarters: 1 } }
    expect(layerFitScale(rotated, 16 / 9, wide)).toBeCloseTo(fitScale(9 / 16, wide), 9)
    // Text and unknown media read as raw scale.
    expect(layerFitScale(makeTextLayer('t', 0, 1), undefined, wide)).toBe(1)
    expect(layerFitScale(video, undefined, wide)).toBe(1)
  })

  it('rescaleForAspect keeps a layer the same size relative to the frame', () => {
    const frame = centeredFrame(1920, 1080)
    const layer = { scale: 0.5625, keyframes: [{ tSec: 0, x: 0, y: 0, scale: 1.125 }] }
    // Phone clip fitted to a 16:9 frame, then cropped to 16:9: it now fills it.
    const cropped = rescaleForAspect(layer, 9 / 16, 16 / 9, frame)
    expect(stretchedBox(16 / 9, cropped.scale).w).toBeCloseTo(1920, 6)
    expect(cropped.keyframes![0].scale).toBeCloseTo(cropped.scale * 2, 9)
    // In 9:16 nothing changes — the same object comes back.
    expect(rescaleForAspect(layer, 9 / 16, 16 / 9, FULL_FRAME)).toBe(layer)
  })
})

describe('videoSourceWindow', () => {
  it('is the trim — all the footage a layer can show, whatever its holds or speed', () => {
    const l = makeVideoLayer('a', 'm', 20, 8)
    const c = {
      ...(l.content as VideoContent),
      inSec: 12.5,
      outSec: 20.5,
      freezes: [{ atSec: 14, holdSec: 3 }],
      speed: 0.5
    }
    expect(videoSourceWindow(c)).toEqual({ startSec: 12.5, durationSec: 8 })
    expect(videoSourceWindow({ inSec: 4, outSec: 3 })).toEqual({ startSec: 4, durationSec: 0 })
  })
})

describe('rebaseVideoContent', () => {
  // A cut piece of a long source: trimmed to 12.5–20.5, with a freeze hold and
  // a speed ramp (a keyframe BEFORE the in-point still shapes the speed there).
  const layer = (): Layer => {
    const l = makeVideoLayer('a', 'src', 30, 8)
    const c: VideoContent = {
      ...(l.content as VideoContent),
      inSec: 12.5,
      outSec: 20.5,
      freezes: [{ atSec: 15, holdSec: 1.5 }],
      speedRamp: [
        { atSec: 10, speed: 2 },
        { atSec: 17, speed: 0.5 },
        { atSec: 20, speed: 1 }
      ],
      crop: { x: 40, y: 40, w: 1000, h: 1500 },
      stabilize: undefined
    }
    return { ...l, content: c, endSec: l.startSec + playedVideoDuration(c) }
  }

  it('shows the same footage at every timeline instant — minus the window start', () => {
    const l = layer()
    const c = l.content as VideoContent
    const r = rebaseVideoContent(c, 'matte', 12.5, { x: 1, y: 1 }, { w: 1080, h: 1920 })
    expect(r.mediaId).toBe('matte')
    expect(r.inSec).toBe(0)
    expect(r.outSec).toBe(8)
    expect(playedVideoDuration(r)).toBeCloseTo(playedVideoDuration(c), 9) // endSec needs no change
    for (let t = l.startSec - 1; t <= l.endSec + 1; t += 0.137) {
      expect(videoSourceTime(r, l, t)).toBeCloseTo(videoSourceTime(c, l, t) - 12.5, 9)
      expect(isFrozenAt(r, l, t)).toBe(isFrozenAt(c, l, t))
    }
  })

  it('rescales a source-pixel crop to the matte size and clamps it inside', () => {
    const c = layer().content as VideoContent
    // A 4K source mattes at half size (the matte caps its long edge at 1920).
    const half = rebaseVideoContent(
      { ...c, crop: { x: 1001, y: 40, w: 1215, h: 2160 } },
      'm2',
      12.5,
      { x: 0.5, y: 0.5 },
      { w: 1920, h: 1080 }
    )
    expect(half.crop).toEqual({ x: 501, y: 0, w: 608, h: 1080 }) // rounded, then clamped to fit
    const same = rebaseVideoContent(c, 'm2', 12.5, { x: 1, y: 1 }, { w: 1080, h: 1920 })
    expect(same.crop).toEqual(c.crop)
    const none = rebaseVideoContent({ ...c, crop: null }, 'm2', 12.5, { x: 1, y: 1 }, { w: 1080, h: 1920 })
    expect(none.crop).toBeNull()
  })

  it('forces stabilization off (the export stabilizes through an opaque intermediate)', () => {
    const c = layer().content as VideoContent
    expect(
      rebaseVideoContent({ ...c, stabilize: undefined }, 'm2', 12.5, { x: 1, y: 1 }, { w: 1, h: 1 }).stabilize
    ).toBeNull()
    expect(
      rebaseVideoContent(
        { ...c, stabilize: { smoothing: 10, shakiness: 5 } as never },
        'm2',
        12.5,
        { x: 1, y: 1 },
        { w: 1, h: 1 }
      ).stabilize
    ).toBeNull()
  })

  it('keeps everything that is not source-anchored', () => {
    const c = {
      ...(layer().content as VideoContent),
      mute: true,
      gainDb: -6,
      color: { brightness: 0.1, contrast: 1.2, saturation: 0.9 }
    }
    const r = rebaseVideoContent(c, 'm2', 12.5, { x: 1, y: 1 }, { w: 1080, h: 1920 })
    expect(r.mute).toBe(true)
    expect(r.gainDb).toBe(-6)
    expect(r.color).toEqual(c.color)
  })
})

describe('windowCoversVideo', () => {
  const win = { startSec: 12.5, durationSec: 8 }
  it('covers the trim it was made from, and any trim or split piece inside it', () => {
    expect(windowCoversVideo({ mediaId: 'src', inSec: 12.5, outSec: 20.5 }, 'src', win)).toBe(true)
    expect(windowCoversVideo({ mediaId: 'src', inSec: 14, outSec: 16 }, 'src', win)).toBe(true)
  })
  it('does not cover a trim extended past the window, or a clip re-pointed meanwhile', () => {
    expect(windowCoversVideo({ mediaId: 'src', inSec: 12, outSec: 20.5 }, 'src', win)).toBe(false)
    expect(windowCoversVideo({ mediaId: 'src', inSec: 12.5, outSec: 21 }, 'src', win)).toBe(false)
    expect(windowCoversVideo({ mediaId: 'other', inSec: 12.5, outSec: 20.5 }, 'src', win)).toBe(false)
  })
})

describe('background pill defaults', () => {
  it('a new text layer and the default caption style start with a fully opaque pill', async () => {
    const { DEFAULT_CAPTION_STYLE } = await import('./project')
    const t = makeTextLayer('t', 0, 3)
    expect(t.content.kind === 'text' && t.content.pill.color).toBe('#000000ff')
    expect(DEFAULT_CAPTION_STYLE.pill.color).toBe('#000000ff')
  })
})
