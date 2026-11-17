/**
 * Live motion presets of a graphics mark — Entrance, Exit and Loop. They play
 * ON TOP of the mark's own keyframes / static pose (`framePoseAt` composes the
 * two), so changing a preset never touches the keyframes. Pure: the preview and
 * the export both draw a mark through `markArtSvg`, so a frame looks the same
 * on both sides. "Convert to keyframes" (`convertPresetsToKeyframes`) bakes the
 * presets into ordinary, editable keyframes.
 *
 * A preset is a list of STOPS over its own 0..1 progress; a stop's easing
 * governs the stretch to the next stop (the same `ease` as keyframes). A value a
 * stop leaves out is the identity (offset/rotation 0, size/opacity/drawn 1).
 *
 * Timing runs on the mark's local clock (seconds after the layer's start; the
 * layer is `layerLenSec` long): visible from `atSec` to the layer's end; the
 * entrance plays over [atSec, atSec + e]; the exit over [L − x, L]; the loop
 * from the entrance's end to the exit's start, phase 0 at the entrance's end.
 */

import { f2, LABEL_FONT_FAMILY, markBounds, markVisibleAt, type GraphicMark } from './graphics'
import {
  ease,
  keyframeFromPose,
  markPoseAt,
  markPoseSvg,
  type Easing,
  type MarkKeyframe,
  type MarkPose
} from './markAnim'
import {
  activeSparkle,
  boxSparkleMaxRadius,
  SPARKLE_SVG_PATH,
  sparklesInBox,
  sparkleStateAt,
  type Sparkle,
  type SparkleBox,
  type SparkleEffect
} from './sparkle'

export type EntranceKind = 'instant' | 'popIn' | 'fadeIn' | 'drawOn' | 'slideIn' | 'grow'
export type ExitKind = 'none' | 'popOut' | 'fadeOut' | 'shrink' | 'slideOut'
export type LoopKind = 'none' | 'pulse' | 'shake' | 'spin' | 'bob'

export interface EntrancePreset {
  kind: EntranceKind
  /** Length in seconds. */
  sec: number
}
export interface ExitPreset {
  kind: ExitKind
  sec: number
}
export interface LoopPreset {
  kind: LoopKind
  /** One cycle's length in seconds. */
  cycleSec: number
}

export const ENTRANCES: { id: EntranceKind; label: string }[] = [
  { id: 'instant', label: 'Instant' },
  { id: 'popIn', label: 'Pop in' },
  { id: 'fadeIn', label: 'Fade in' },
  { id: 'drawOn', label: 'Draw on' },
  { id: 'slideIn', label: 'Slide in' },
  { id: 'grow', label: 'Grow' }
]
export const EXITS: { id: ExitKind; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'popOut', label: 'Pop out' },
  { id: 'fadeOut', label: 'Fade out' },
  { id: 'shrink', label: 'Shrink' },
  { id: 'slideOut', label: 'Slide out' }
]
export const LOOPS: { id: LoopKind; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'shake', label: 'Shake' },
  { id: 'spin', label: 'Spin' },
  { id: 'bob', label: 'Bob' }
]

/** Shortest entrance / exit / loop cycle (s). */
export const MIN_PRESET_SEC = 0.05
/** How far (mark-space px) a slide travels; positive y is down. */
export const SLIDE_PX = 150

/** The length a preset starts with when it is picked. */
export const DEFAULT_ENTRANCE_SEC: Record<EntranceKind, number> = {
  instant: 0.4,
  popIn: 0.35,
  fadeIn: 0.4,
  drawOn: 0.4,
  slideIn: 0.4,
  grow: 0.35
}
export const DEFAULT_EXIT_SEC = 0.3
export const DEFAULT_LOOP_SEC: Record<LoopKind, number> = { none: 1, pulse: 0.8, shake: 0.2, spin: 2, bob: 1.2 }

/** One point of a preset: values at progress `f` (0..1), missing = identity. */
export interface PresetStop {
  f: number
  dx?: number
  dy?: number
  scale?: number
  rotationDeg?: number
  opacity?: number
  drawn?: number
  /** Easing of the stretch FROM this stop to the next. */
  easing: Easing
}

const ENTRANCE_STOPS: Record<EntranceKind, PresetStop[]> = {
  instant: [],
  fadeIn: [
    { f: 0, opacity: 0, easing: 'linear' },
    { f: 1, opacity: 1, easing: 'linear' }
  ],
  drawOn: [
    { f: 0, drawn: 0, easing: 'linear' },
    { f: 1, drawn: 1, easing: 'linear' }
  ],
  popIn: [
    { f: 0, scale: 0, opacity: 0, easing: 'easeOut' },
    { f: 0.6, scale: 1.15, opacity: 1, easing: 'easeInOut' },
    { f: 1, scale: 1, easing: 'linear' }
  ],
  slideIn: [
    { f: 0, dy: SLIDE_PX, opacity: 0, easing: 'easeOut' },
    { f: 1, dy: 0, opacity: 1, easing: 'linear' }
  ],
  grow: [
    { f: 0, scale: 0, easing: 'easeOut' },
    { f: 1, scale: 1, easing: 'linear' }
  ]
}

const EXIT_STOPS: Record<ExitKind, PresetStop[]> = {
  none: [],
  fadeOut: [
    { f: 0, opacity: 1, easing: 'linear' },
    { f: 1, opacity: 0, easing: 'linear' }
  ],
  shrink: [
    { f: 0, scale: 1, easing: 'easeIn' },
    { f: 1, scale: 0, easing: 'linear' }
  ],
  popOut: [
    { f: 0, scale: 1, easing: 'easeOut' },
    { f: 0.4, scale: 1.15, easing: 'easeIn' },
    { f: 1, scale: 0, opacity: 0, easing: 'linear' }
  ],
  slideOut: [
    { f: 0, dy: 0, opacity: 1, easing: 'easeIn' },
    { f: 1, dy: SLIDE_PX, opacity: 0, easing: 'linear' }
  ]
}

/** One cycle of each loop. */
const LOOP_STOPS: Record<LoopKind, PresetStop[]> = {
  none: [],
  pulse: [
    { f: 0, scale: 1, easing: 'easeInOut' },
    { f: 0.5, scale: 1.1, easing: 'easeInOut' },
    { f: 1, scale: 1, easing: 'linear' }
  ],
  shake: [
    { f: 0, dx: 0, easing: 'easeInOut' },
    { f: 0.25, dx: 12, easing: 'easeInOut' },
    { f: 0.75, dx: -12, easing: 'easeInOut' },
    { f: 1, dx: 0, easing: 'linear' }
  ],
  spin: [
    { f: 0, rotationDeg: 0, easing: 'linear' },
    { f: 1, rotationDeg: 360, easing: 'linear' }
  ],
  bob: [
    { f: 0, dy: 0, easing: 'easeInOut' },
    { f: 0.5, dy: -24, easing: 'easeInOut' },
    { f: 1, dy: 0, easing: 'linear' }
  ]
}
/** What a loop adds for every COMPLETED cycle (a spin keeps turning, not snapping back). */
const LOOP_PER_CYCLE: Partial<Record<LoopKind, { rotationDeg: number }>> = { spin: { rotationDeg: 360 } }

/** The stops of an entrance / exit / one loop cycle (empty for instant / none / an unknown kind). */
export const entranceStops = (k: EntranceKind): PresetStop[] => ENTRANCE_STOPS[k] ?? []
export const exitStops = (k: ExitKind): PresetStop[] => EXIT_STOPS[k] ?? []
export const loopStops = (k: LoopKind): PresetStop[] => LOOP_STOPS[k] ?? []

/** What a preset adds to a pose: offsets and rotation ADD, size / opacity / drawn MULTIPLY. */
export interface PresetDelta {
  dx: number
  dy: number
  scale: number
  rotationDeg: number
  opacity: number
  drawn: number
}
const IDENTITY: PresetDelta = { dx: 0, dy: 0, scale: 1, rotationDeg: 0, opacity: 1, drawn: 1 }

const stopDelta = (s: PresetStop): PresetDelta => ({
  dx: s.dx ?? 0,
  dy: s.dy ?? 0,
  scale: s.scale ?? 1,
  rotationDeg: s.rotationDeg ?? 0,
  opacity: s.opacity ?? 1,
  drawn: s.drawn ?? 1
})

const mix = (a: number, b: number, f: number): number => a + (b - a) * f
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The values of `stops` at progress `f`: held before the first and after the last, between two blended by the FIRST one's easing. */
export function stopsValueAt(stops: PresetStop[], f: number): PresetDelta {
  if (stops.length === 0) return IDENTITY
  if (f <= stops[0].f) return stopDelta(stops[0])
  const last = stops[stops.length - 1]
  if (f >= last.f) return stopDelta(last)
  let i = 0
  while (i < stops.length - 2 && f >= stops[i + 1].f) i++
  const a = stops[i]
  const b = stops[i + 1]
  const w = ease(a.easing, (f - a.f) / (b.f - a.f))
  const da = stopDelta(a)
  const db = stopDelta(b)
  return {
    dx: mix(da.dx, db.dx, w),
    dy: mix(da.dy, db.dy, w),
    scale: mix(da.scale, db.scale, w),
    rotationDeg: mix(da.rotationDeg, db.rotationDeg, w),
    opacity: mix(da.opacity, db.opacity, w),
    drawn: mix(da.drawn, db.drawn, w)
  }
}

const compose = (a: PresetDelta, b: PresetDelta): PresetDelta => ({
  dx: a.dx + b.dx,
  dy: a.dy + b.dy,
  scale: a.scale * b.scale,
  rotationDeg: a.rotationDeg + b.rotationDeg,
  opacity: a.opacity * b.opacity,
  drawn: a.drawn * b.drawn
})

// --- Timing ---------------------------------------------------------------------

const entranceOf = (m: GraphicMark): EntrancePreset => m.entrance ?? { kind: 'instant', sec: 0 }
const hasExit = (m: GraphicMark): boolean => !!m.exit && exitStops(m.exit.kind).length > 0
const hasLoop = (m: GraphicMark): boolean => !!m.loop && loopStops(m.loop.kind).length > 0

/** Whether the entrance has motion at all (anything but Instant). */
const hasEntranceMotion = (m: GraphicMark): boolean => entranceStops(entranceOf(m).kind).length > 0

export interface PresetTiming {
  /** Entrance length actually used (s); 0 for Instant. */
  e: number
  /** Exit length actually used (s); 0 for none. */
  x: number
  /** Where the entrance ends / the exit starts (local seconds). */
  entranceEnd: number
  exitStart: number
}

/**
 * The entrance and exit lengths a mark really plays over a `layerLenSec` layer:
 * as asked, unless there is an exit AND together they are longer than the
 * on-screen time from `atSec` to the layer's end, when both shrink in
 * proportion. With no exit the entrance keeps its full length and is simply cut
 * off by the layer's end (as the old fixed 0.4 s reveal was). (Measured from
 * `atSec` itself, not from the layer's start, so a trim or a split that moves
 * `atSec` negative leaves it unchanged.) Instant has no length.
 */
export function presetTiming(m: GraphicMark, layerLenSec: number): PresetTiming {
  let e = hasEntranceMotion(m) ? Math.max(MIN_PRESET_SEC, entranceOf(m).sec) : 0
  let x = hasExit(m) ? Math.max(MIN_PRESET_SEC, m.exit!.sec) : 0
  const avail = Math.max(0, layerLenSec - m.atSec)
  if (x > 0 && e + x > avail) {
    const k = avail / (e + x)
    e *= k
    x *= k
  }
  return { e, x, entranceEnd: m.atSec + e, exitStart: layerLenSec - x }
}

/** The combined effect of the mark's entrance, exit and loop at `localSec`. */
export function presetDeltaAt(m: GraphicMark, localSec: number, layerLenSec: number): PresetDelta {
  const { e, x, entranceEnd, exitStart } = presetTiming(m, layerLenSec)
  let d = IDENTITY
  if (e > 0) d = compose(d, stopsValueAt(entranceStops(entranceOf(m).kind), clamp((localSec - m.atSec) / e, 0, 1)))
  if (hasLoop(m)) {
    // Runs from the entrance's end to the exit's start, then holds where it
    // was (so an exit carries on from the loop's last pose, not a snap).
    const cycle = Math.max(MIN_PRESET_SEC, m.loop!.cycleSec)
    const span = Math.max(0, exitStart - entranceEnd)
    const n = clamp(localSec - entranceEnd, 0, span) / cycle
    const done = Math.floor(n + 1e-9)
    const v = stopsValueAt(loopStops(m.loop!.kind), Math.max(0, n - done))
    const per = LOOP_PER_CYCLE[m.loop!.kind]
    d = compose(d, per ? { ...v, rotationDeg: v.rotationDeg + per.rotationDeg * done } : v)
  }
  if (x > 0 && localSec > exitStart) {
    d = compose(d, stopsValueAt(exitStops(m.exit!.kind), clamp((localSec - exitStart) / x, 0, 1)))
  }
  return d
}

/** The pose the mark is drawn at `localSec`: its own (keyframes or static) with the presets composed on. Colours untouched. */
export function framePoseAt(m: GraphicMark, localSec: number, layerLenSec: number): MarkPose {
  const base = markPoseAt(m, localSec)
  const d = presetDeltaAt(m, localSec, layerLenSec)
  return {
    ...base,
    dx: base.dx + d.dx,
    dy: base.dy + d.dy,
    rotationDeg: base.rotationDeg + d.rotationDeg,
    scale: base.scale * d.scale,
    opacity: base.opacity * d.opacity,
    drawn: base.drawn * d.drawn
  }
}

/**
 * Whether the mark has a preset that only the frame-by-frame export can draw:
 * an entrance beyond Instant / Fade in / Draw on (those two are an alpha fade
 * and a PNG sequence), an exit or a loop.
 */
export function hasLivePresets(m: GraphicMark): boolean {
  const k = entranceOf(m).kind
  return !(k === 'instant' || k === 'fadeIn' || k === 'drawOn') || hasExit(m) || hasLoop(m)
}

// --- Sparkles ---------------------------------------------------------------------

/** The mark's sparkle effect when it draws any (on, with a positive density). */
export const markSparkle = (m: GraphicMark): SparkleEffect | null => activeSparkle({ sparkle: m.sparkle })

/**
 * The area sparkle CENTRES scatter over, in mark space: the mark's own bounds
 * (at its base thickness, so a keyframed width never reshuffles them), padded a
 * little so the glints frame the shape instead of sitting only on it.
 */
export function sparkleBox(m: GraphicMark): SparkleBox {
  const b = markBounds(m)
  const pad = Math.max(16, Math.min(48, Math.max(b.w, b.h) * 0.12))
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w + pad * 2, h: b.h + pad * 2 }
}

/** The rectangle (mark space) everything a mark's sparkles can paint lies in: the scatter box plus a star's reach. */
export function sparkleExtent(m: GraphicMark): { x: number; y: number; w: number; h: number } {
  const box = sparkleBox(m)
  const r = boxSparkleMaxRadius(box)
  return { x: box.cx - box.w / 2 - r, y: box.cy - box.h / 2 - r, w: box.w + r * 2, h: box.h + r * 2 }
}

/** Sparkle sets by their inputs: the animated export asks for one per output frame. */
const sparkleCache = new Map<string, Sparkle[]>()

/**
 * Every sparkle of a mark over its on-screen window [max(atSec, 0), layer end];
 * `tSec` is from the window's start (mark-local time = max(atSec, 0) + tSec).
 * Seeded from the mark id, so it never reshuffles. Empty when sparkles are off.
 */
export function markSparkles(m: GraphicMark, layerLenSec: number): Sparkle[] {
  const effect = markSparkle(m)
  const dur = layerLenSec - Math.max(0, m.atSec)
  if (!effect || dur <= 0) return []
  const box = sparkleBox(m)
  const key = [m.id, effect.density, dur.toFixed(3), box.cx, box.cy, box.w, box.h].join('|')
  let out = sparkleCache.get(key)
  if (!out) {
    if (sparkleCache.size >= 32) sparkleCache.clear()
    out = sparklesInBox({ effect, seed: m.id, box, durSec: dur })
    sparkleCache.set(key, out)
  }
  return out
}

/** The live sparkles of a mark at `localSec` as SVG: small four-point stars in the effect colour. */
export function markSparklesSvg(m: GraphicMark, localSec: number, layerLenSec: number): string {
  const effect = markSparkle(m)
  if (!effect) return ''
  const t = localSec - Math.max(0, m.atSec)
  const r3 = (n: number): number => Math.round(n * 1000) / 1000
  let out = ''
  for (const s of markSparkles(m, layerLenSec)) {
    const st = sparkleStateAt(s, t)
    if (st.opacity <= 0) continue
    out +=
      `<path data-mark-sparkle="" d="${SPARKLE_SVG_PATH}" fill="${effect.color}" opacity="${r3(st.opacity)}" ` +
      `transform="translate(${f2(s.x)} ${f2(s.y)}) rotate(${f2(s.rotDeg)}) scale(${r3((s.sizePx * st.scale) / 10)})"/>`
  }
  return out
}

/**
 * THE drawing of a mark `localSec` after its layer's start, for the preview and
 * the export alike: '' before the mark appears, else its group at that moment's
 * pose (keyframes + presets; a draw-on's progress and a fade's opacity are the
 * pose's `drawn` / `opacity`), with its sparkles INSIDE the same group so they
 * follow the pose and fade with it.
 */
export function markArtSvg(
  m: GraphicMark,
  localSec: number,
  layerLenSec: number,
  fontFamily: string = LABEL_FONT_FAMILY
): string {
  if (!markVisibleAt(m, localSec)) return ''
  const pose = framePoseAt(m, localSec, layerLenSec)
  return markPoseSvg(m, pose, 1, 1, fontFamily, markSparklesSvg(m, localSec, layerLenSec))
}

// --- Convert to keyframes -------------------------------------------------------

/** How close two keyframes may sit (s) before they count as the same moment. */
const KEYFRAME_EPS = 0.02
/** A loop longer than this many cycles is not unrolled further. */
const MAX_LOOP_CYCLES = 2000

/** Whether Convert can bake this mark's presets, and why not if it can't (the loop would need too many keyframes). */
export function canConvertPresets(m: GraphicMark, layerLenSec: number): { ok: boolean; reason?: string } {
  if (!hasLoop(m)) return { ok: true }
  const { entranceEnd, exitStart } = presetTiming(m, layerLenSec)
  const cycle = Math.max(MIN_PRESET_SEC, m.loop!.cycleSec)
  const cycles = Math.ceil(Math.max(0, exitStart - entranceEnd) / cycle - 1e-9)
  if (cycles > MAX_LOOP_CYCLES)
    return {
      ok: false,
      reason: `The loop repeats ${cycles} times, more than the ${MAX_LOOP_CYCLES} cycles that can be turned into keyframes. Lengthen the cycle first.`
    }
  return { ok: true }
}

/**
 * The mark with its presets baked into keyframes. A keyframe is written at every
 * time the mark already has one and at every preset stop (the entrance's and
 * exit's, each loop cycle's, and the exit's start while a loop runs), clipped to
 * [max(atSec, 0), layer end] and merged within 0.02 s; each holds `framePoseAt`
 * there, and eases like the preset stop at that time if it is one, else like
 * the keyframe already there, else linearly. The entrance becomes Instant (its
 * length kept) and the exit and loop go.
 *
 * EXACT only when the mark has no keyframes of its own, its presets do not
 * overlap, and every loop cycle is whole (the stops and easings are copied, so
 * the keyframes replay the preset). Approximate otherwise: a partial last loop
 * cycle, a loop held through an exit, presets over existing keyframes' own
 * stretches, or stops closer than 0.02 s. A loop that would need more than
 * MAX_LOOP_CYCLES cycles is not converted — check `canConvertPresets` first
 * (this function then returns the mark unchanged rather than truncating).
 */
export function convertPresetsToKeyframes(m: GraphicMark, layerLenSec: number): GraphicMark {
  const ent = entranceOf(m)
  if (!hasEntranceMotion(m) && !hasExit(m) && !hasLoop(m)) return m
  if (!canConvertPresets(m, layerLenSec).ok) return m
  const { e, x, entranceEnd, exitStart } = presetTiming(m, layerLenSec)
  const lo = Math.max(0, m.atSec)
  const hi = Math.max(lo, layerLenSec)

  interface Slot {
    tSec: number
    existing: Easing | null
    preset: Easing | null
  }
  const slots: Slot[] = (m.keyframes ?? []).map((k) => ({ tSec: k.tSec, existing: k.easing, preset: null }))
  const stop = (t: number, easing: Easing | null): void => {
    const at = clamp(t, lo, hi)
    let best: Slot | undefined
    for (const s of slots)
      if (Math.abs(s.tSec - at) <= KEYFRAME_EPS && (!best || Math.abs(s.tSec - at) < Math.abs(best.tSec - at))) best = s
    if (!best) slots.push({ tSec: at, existing: null, preset: easing })
    else if (easing) best.preset = easing
  }
  /** A preset's stops placed over [t0, t0 + len]; a stop's easing counts only where a stretch starts. */
  const place = (stops: PresetStop[], t0: number, len: number, lastStartsStretch = false): void => {
    stops.forEach((s, i) => stop(t0 + s.f * len, i < stops.length - 1 || lastStartsStretch ? s.easing : null))
  }

  if (e > 0) place(entranceStops(ent.kind), m.atSec, e)
  if (hasLoop(m)) {
    const stops = loopStops(m.loop!.kind)
    const cycle = Math.max(MIN_PRESET_SEC, m.loop!.cycleSec)
    for (let n = 0; n < MAX_LOOP_CYCLES && entranceEnd + n * cycle < exitStart - 1e-9; n++) {
      for (const s of stops) {
        const t = entranceEnd + (n + s.f) * cycle
        if (t <= exitStart + 1e-9) stop(t, s.f < 1 ? s.easing : null)
      }
    }
    // The loop's last (partial) pose, where the exit takes over.
    stop(exitStart, null)
  }
  if (x > 0) place(exitStops(m.exit!.kind), exitStart, x)

  const keyframes: MarkKeyframe[] = slots
    .sort((a, b) => a.tSec - b.tSec)
    .map((s) => keyframeFromPose(s.tSec, framePoseAt(m, s.tSec, layerLenSec), s.preset ?? s.existing ?? 'linear'))

  const { exit: _exit, loop: _loop, ...rest } = m
  void _exit
  void _loop
  return { ...rest, keyframes, entrance: { kind: 'instant', sec: ent.sec } }
}
