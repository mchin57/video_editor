import { describe, expect, it } from 'vitest'
import { newMark, type GraphicMark } from './graphics'
import { ease, markPoseAt, type MarkKeyframe } from './markAnim'
import {
  SLIDE_PX,
  canConvertPresets,
  convertPresetsToKeyframes,
  entranceStops,
  exitStops,
  framePoseAt,
  hasLivePresets,
  loopStops,
  markArtSvg,
  presetDeltaAt,
  presetTiming,
  stopsValueAt,
  type EntranceKind,
  type ExitKind,
  type LoopKind
} from './markPresets'

const L = 3
const rect = (extra: Partial<GraphicMark> = {}): GraphicMark => ({
  ...newMark('rect', 'R', { x: 100, y: 200 }, { x: 300, y: 400 }, 0.5),
  ...extra
})
const ent = (kind: EntranceKind, sec: number): Partial<GraphicMark> => ({ entrance: { kind, sec } })
const kf = (tSec: number, extra: Partial<MarkKeyframe> = {}): MarkKeyframe => ({
  tSec,
  dx: 0,
  dy: 0,
  scale: 1,
  rotationDeg: 0,
  opacity: 1,
  drawn: 1,
  color: '#ffd60a',
  widthPx: 8,
  easing: 'linear',
  ...extra
})
const KEYS = ['dx', 'dy', 'scale', 'rotationDeg', 'opacity', 'drawn'] as const

describe('preset values at their stops', () => {
  it('entrances', () => {
    const at = (k: EntranceKind, f: number) => stopsValueAt(entranceStops(k), f)
    expect(entranceStops('instant')).toEqual([])
    expect(at('fadeIn', 0).opacity).toBe(0)
    expect(at('fadeIn', 1).opacity).toBe(1)
    expect(at('fadeIn', 0.5).opacity).toBeCloseTo(0.5)
    expect(at('drawOn', 0).drawn).toBe(0)
    expect(at('drawOn', 0.25).drawn).toBeCloseTo(0.25)
    expect(at('popIn', 0)).toMatchObject({ scale: 0, opacity: 0 })
    expect(at('popIn', 0.6)).toMatchObject({ scale: 1.15, opacity: 1 })
    expect(at('popIn', 1)).toMatchObject({ scale: 1, opacity: 1 })
    // Ease-out to the overshoot: 0.3 is half way through the first stretch.
    expect(at('popIn', 0.3).scale).toBeCloseTo(1.15 * ease('easeOut', 0.5))
    expect(at('slideIn', 0)).toMatchObject({ dy: SLIDE_PX, opacity: 0 })
    expect(at('slideIn', 1)).toMatchObject({ dy: 0, opacity: 1 })
    expect(at('slideIn', 0.5).dy).toBeCloseTo(SLIDE_PX * (1 - ease('easeOut', 0.5)))
    expect(at('grow', 0).scale).toBe(0)
    expect(at('grow', 1).scale).toBe(1)
  })
  it('exits', () => {
    const at = (k: ExitKind, f: number) => stopsValueAt(exitStops(k), f)
    expect(at('fadeOut', 0).opacity).toBe(1)
    expect(at('fadeOut', 1).opacity).toBe(0)
    expect(at('shrink', 0.5).scale).toBeCloseTo(1 - ease('easeIn', 0.5))
    expect(at('shrink', 1).scale).toBe(0)
    expect(at('popOut', 0.4)).toMatchObject({ scale: 1.15, opacity: 1 })
    expect(at('popOut', 1)).toMatchObject({ scale: 0, opacity: 0 })
    expect(at('slideOut', 1)).toMatchObject({ dy: SLIDE_PX, opacity: 0 })
    expect(at('slideOut', 0).dy).toBe(0)
  })
  it('loops', () => {
    const at = (k: LoopKind, f: number) => stopsValueAt(loopStops(k), f)
    expect(at('pulse', 0.5).scale).toBeCloseTo(1.1)
    expect(at('pulse', 1).scale).toBe(1)
    expect(at('shake', 0.25).dx).toBe(12)
    expect(at('shake', 0.75).dx).toBe(-12)
    expect(at('shake', 1).dx).toBe(0)
    expect(at('spin', 0.5).rotationDeg).toBeCloseTo(180)
    expect(at('bob', 0.5).dy).toBe(-24)
    expect(at('bob', 1).dy).toBe(0)
  })
})

describe('timing', () => {
  it('plays the entrance from atSec and the exit ending at the layer end', () => {
    const m = rect({ ...ent('fadeIn', 0.4), exit: { kind: 'fadeOut', sec: 0.5 } })
    expect(presetTiming(m, L)).toMatchObject({ e: 0.4, x: 0.5, entranceEnd: 0.9, exitStart: 2.5 })
    expect(presetDeltaAt(m, 0.7, L).opacity).toBeCloseTo(0.5)
    expect(presetDeltaAt(m, 1.5, L).opacity).toBe(1)
    expect(presetDeltaAt(m, 2.75, L).opacity).toBeCloseTo(0.5)
    expect(presetDeltaAt(m, 3, L).opacity).toBe(0)
  })
  it('an exit stays end-anchored when the layer is shorter or longer', () => {
    const m = rect({ exit: { kind: 'fadeOut', sec: 0.5 } })
    expect(presetTiming(m, 10).exitStart).toBe(9.5)
    expect(presetTiming(m, 2).exitStart).toBe(1.5)
  })
  it('shrinks entrance and exit in proportion when they do not fit', () => {
    // On screen from 0.5 to 3: 2.5 s; asked for 2 + 3 = 5.
    const m = rect({ ...ent('fadeIn', 2), exit: { kind: 'fadeOut', sec: 3 } })
    const t = presetTiming(m, L)
    expect(t.e).toBeCloseTo(1)
    expect(t.x).toBeCloseTo(1.5)
    expect(t.entranceEnd).toBeCloseTo(t.exitStart)
  })
  it('an old fade / draw mark late in the layer keeps its full 0.4 s entrance (no exit, nothing to shrink for)', () => {
    for (const kind of ['fadeIn', 'drawOn'] as const) {
      const m = rect({ ...ent(kind, 0.4), atSec: L - 0.2 })
      const t = presetTiming(m, L)
      expect(t.e).toBe(0.4)
      expect(t.x).toBe(0)
    }
  })
  it('edge cases give finite, sensible values', () => {
    const finite = (t: ReturnType<typeof presetTiming>): void => {
      for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true)
    }
    const m = (atSec: number) => rect({ ...ent('fadeIn', 0.4), exit: { kind: 'fadeOut', sec: 0.5 }, atSec })
    // Negative atSec (a trimmed tile): measured from atSec, so nothing shrinks.
    const neg = presetTiming(m(-1), L)
    finite(neg)
    expect(neg).toMatchObject({ e: 0.4, x: 0.5, entranceEnd: -0.6, exitStart: 2.5 })
    // atSec past the layer end: no room, both collapse to 0.
    const past = presetTiming(m(L + 1), L)
    finite(past)
    expect(past.e).toBe(0)
    expect(past.x).toBe(0)
    // Zero-length layer.
    const zero = presetTiming(m(0), 0)
    finite(zero)
    expect(zero.e).toBe(0)
    expect(zero.x).toBe(0)
    for (const len of [0, L])
      for (const at of [-1, 0, L + 1])
        for (const t of [-1, 0, 1, 5]) {
          const d = presetDeltaAt(m(at), t, len)
          for (const k of KEYS) expect(Number.isFinite(d[k]), `${k} at atSec ${at} t ${t} L ${len}`).toBe(true)
        }
    // No exit, L = 0: the entrance keeps its length, exit start is 0.
    const noExit = presetTiming(rect(ent('fadeIn', 0.4)), 0)
    finite(noExit)
    expect(noExit.e).toBe(0.4)
  })
  it('Instant has no length: a loop starts at atSec', () => {
    expect(presetTiming(rect(), L).entranceEnd).toBe(0.5)
  })
  it('a loop starts at phase 0 when the entrance ends, and a spin keeps accumulating', () => {
    const m = rect({ ...ent('popIn', 0.35), loop: { kind: 'spin', cycleSec: 1 } })
    const start = 0.5 + 0.35
    expect(presetDeltaAt(m, start, L).rotationDeg).toBe(0)
    expect(presetDeltaAt(m, start + 0.5, L).rotationDeg).toBeCloseTo(180)
    expect(presetDeltaAt(m, start + 1, L).rotationDeg).toBeCloseTo(360)
    expect(presetDeltaAt(m, start + 1.5, L).rotationDeg).toBeCloseTo(540)
    // No loop motion during the entrance.
    expect(presetDeltaAt(rect({ ...ent('fadeIn', 0.4), loop: { kind: 'bob', cycleSec: 1 } }), 0.7, L).dy).toBe(0)
  })
  it('the loop holds where it was when the exit takes over', () => {
    const m = rect({ loop: { kind: 'bob', cycleSec: 1 }, exit: { kind: 'shrink', sec: 0.5 } })
    const held = presetDeltaAt(m, 2.5, L).dy
    expect(presetDeltaAt(m, 2.9, L).dy).toBe(held)
  })
})

describe('composition', () => {
  it('adds offsets and rotation, multiplies size / opacity / drawn, leaves colours', () => {
    const m = rect({ ...ent('popIn', 1), keyframes: [kf(0, { dx: 10, scale: 2, opacity: 0.5, rotationDeg: 30 })] })
    const p = framePoseAt(m, 0.5, L) // entrance f=0: scale 0, opacity 0
    expect(p).toMatchObject({ dx: 10, scale: 0, opacity: 0, rotationDeg: 30, color: '#ffd60a' })
    const q = framePoseAt(m, 1.6, L) // entrance over
    expect(q).toMatchObject({ dx: 10, scale: 2, opacity: 0.5 })
    const s = framePoseAt(rect({ ...ent('slideIn', 1), scale: 2 }), 0.5, L)
    expect(s.dy).toBe(SLIDE_PX)
    expect(s.scale).toBe(2)
  })
  it('hasLivePresets: only what the still export cannot draw', () => {
    expect(hasLivePresets(rect())).toBe(false)
    expect(hasLivePresets(rect(ent('fadeIn', 0.4)))).toBe(false)
    expect(hasLivePresets(rect(ent('drawOn', 0.4)))).toBe(false)
    expect(hasLivePresets(rect(ent('popIn', 0.4)))).toBe(true)
    expect(hasLivePresets(rect({ exit: { kind: 'fadeOut', sec: 0.3 } }))).toBe(true)
    expect(hasLivePresets(rect({ loop: { kind: 'pulse', cycleSec: 1 } }))).toBe(true)
  })
  it('markArtSvg is empty before the mark appears, else drawn at the frame pose', () => {
    expect(markArtSvg(rect(), 0.4, L)).toBe('')
    expect(markArtSvg(rect(), 0.5, L)).toMatch(/^<g><path /)
    expect(markArtSvg(rect(ent('fadeIn', 0.4)), 0.7, L)).toContain('opacity="0.5"')
    expect(markArtSvg(rect({ ...ent('fadeIn', 0.4), opacity: 0.5 }), 0.7, L)).toContain('opacity="0.25"')
    expect(markArtSvg(rect(ent('popIn', 1)), 0.5, L)).toContain('scale(0)')
  })
})

describe('convertPresetsToKeyframes', () => {
  const same = (a: GraphicMark, b: GraphicMark, t: number, len = L): void => {
    const pa = framePoseAt(a, t, len)
    const pb = framePoseAt(b, t, len)
    for (const k of KEYS) expect(pb[k], `${k} at ${t}`).toBeCloseTo(pa[k], 6)
  }

  it('a pop-in replays exactly as keyframes, at every stop and between', () => {
    const m = rect(ent('popIn', 0.35))
    const c = convertPresetsToKeyframes(m, L)
    expect(c.entrance.kind).toBe('instant')
    expect(c.exit).toBeUndefined()
    expect(c.loop).toBeUndefined()
    expect(c.keyframes!.map((k) => k.tSec)).toEqual([0.5, 0.5 + 0.6 * 0.35, 0.85])
    expect(c.keyframes!.map((k) => k.easing)).toEqual(['easeOut', 'easeInOut', 'linear'])
    for (const k of c.keyframes!) same(m, c, k.tSec)
    for (let i = 0; i < 20; i++) same(m, c, 0.5 + (i * 0.4) / 19)
    same(m, c, 2)
  })

  it('an exit converts exactly too', () => {
    const m = rect({ exit: { kind: 'popOut', sec: 0.5 } })
    const c = convertPresetsToKeyframes(m, L)
    for (let i = 0; i <= 20; i++) same(m, c, 0.5 + (i * 2.5) / 20)
  })

  it('a spin loop converts with accumulating rotation', () => {
    const m = rect({ loop: { kind: 'spin', cycleSec: 1 } })
    const c = convertPresetsToKeyframes(m, L)
    const rot = (t: number): number => markPoseAt(c, t).rotationDeg
    expect(rot(0.5)).toBeCloseTo(0)
    expect(rot(1.5)).toBeCloseTo(360)
    expect(rot(2.5)).toBeCloseTo(720)
    expect(rot(3)).toBeCloseTo(900)
    same(m, c, 2.2)
  })

  it('keeps the existing keyframes (their times, and their easing where no stop is)', () => {
    const m = rect({ ...ent('fadeIn', 0.4), keyframes: [kf(0.5, { dx: 0, easing: 'easeIn' }), kf(2, { dx: 100 })] })
    const c = convertPresetsToKeyframes(m, L)
    const times = c.keyframes!.map((k) => k.tSec)
    expect(times).toContain(2)
    expect(times).toContain(0.5)
    expect(c.keyframes!.find((k) => k.tSec === 2)!.dx).toBe(100)
  })

  it('a pulse loop with whole cycles converts exactly', () => {
    // On screen 0.5..3 = 2.5 s = 5 cycles of 0.5 s.
    const m = rect({ loop: { kind: 'pulse', cycleSec: 0.5 } })
    const c = convertPresetsToKeyframes(m, L)
    expect(c.loop).toBeUndefined()
    for (let i = 0; i < 20; i++) same(m, c, 0.5 + (i * 2.5) / 19)
  })

  it('converting over existing keyframes keeps them', () => {
    const m = rect({
      loop: { kind: 'pulse', cycleSec: 0.5 },
      keyframes: [kf(0.5, { dx: 5 }), kf(1.3, { dx: 40 }), kf(2.8, { dx: 90 })]
    })
    const c = convertPresetsToKeyframes(m, L)
    for (const t of [0.5, 1.3, 2.8]) expect(c.keyframes!.some((k) => k.tSec === t)).toBe(true)
    expect(c.keyframes!.find((k) => k.tSec === 1.3)!.dx).toBe(40)
    expect(c.keyframes!.length).toBeGreaterThan(3)
  })

  it('refuses a loop that would need more than the cycle cap, and leaves the mark alone', () => {
    const m = rect({ loop: { kind: 'pulse', cycleSec: 0.05 } })
    const long = 200 // 199.5 s / 0.05 s = 3990 cycles
    const r = canConvertPresets(m, long)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/2000/)
    expect(convertPresetsToKeyframes(m, long)).toBe(m)
    expect(canConvertPresets(m, L).ok).toBe(true)
    expect(canConvertPresets(rect(ent('popIn', 0.3)), L)).toEqual({ ok: true })
  })

  it('does nothing for a mark with no presets', () => {
    const m = rect()
    expect(convertPresetsToKeyframes(m, L)).toBe(m)
  })
})
