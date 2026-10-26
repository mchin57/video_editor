/**
 * The WORKOUT GRAPH's math (docs/WORKOUT-OVERLAY.md "The graph window"): the
 * recording's power / elevation / speed / heart rate drawn against TIME or
 * DISTANCE, zoomable from the whole recording down to 1 second across the
 * width. Pure: the dialog (`WorkoutGraphDialog`) is a view over it.
 *
 * Everything is placed on an AXIS — ride seconds, or metres covered — through
 * `axisMap`, which also maps back: a press on the graph becomes a moment of
 * the recording, whatever the axis.
 */

import type { WorkoutChannel, WorkoutSeries, DistanceUnits } from './workout'
import { sampleIndexAt, workoutDurationSec } from './workout'
import { clamp } from './math'

export type GraphAxis = 'time' | 'distance'

export type GraphLineId = 'power' | 'altitude' | 'speed' | 'heartRate'

export interface GraphLine {
  id: GraphLineId
  label: string
  channel: WorkoutChannel
  values: (s: WorkoutSeries) => (number | null)[] | undefined
  color: string
}

/** The lines the graph can draw, in the order of its toggles. */
export const GRAPH_LINES: GraphLine[] = [
  { id: 'power', label: 'Power', channel: 'power', values: (s) => s.powerW, color: '#facc15' },
  { id: 'altitude', label: 'Elevation', channel: 'altitude', values: (s) => s.altitudeM, color: '#a3a3a3' },
  { id: 'speed', label: 'Speed', channel: 'speed', values: (s) => s.speedMps, color: '#38bdf8' },
  { id: 'heartRate', label: 'Heart rate', channel: 'heartRate', values: (s) => s.heartRate, color: '#fb7185' }
]

/** Narrowest view: 1 s of the recording across the whole width, or 10 m. */
export const MIN_SPAN = { time: 1, distance: 10 } as const

/** Where every sample sits on an axis, and the way back to ride seconds. */
export interface AxisMap {
  axis: GraphAxis
  /** The axis runs 0 → `domain` (seconds, or metres). */
  domain: number
  minSpan: number
  /** Each sample's position (aligned with `series.t`, never decreasing). */
  at: number[]
  toAxis: (sec: number) => number
  toSec: (x: number) => number
}

/** The axis, or null for a distance axis over a file with no distance. */
export function axisMap(s: WorkoutSeries, axis: GraphAxis): AxisMap | null {
  const dur = workoutDurationSec(s)
  if (axis === 'time') {
    return {
      axis,
      domain: dur,
      minSpan: MIN_SPAN.time,
      at: s.t,
      toAxis: (sec) => clamp(sec, 0, dur),
      toSec: (x) => clamp(x, 0, dur)
    }
  }
  if (!s.distanceM) return null
  // Metres covered so far: a sample without a reading keeps the last one, and
  // a GPS wobble backwards never takes the axis back.
  const at: number[] = new Array(s.t.length)
  let run = 0
  for (let i = 0; i < s.t.length; i++) {
    const d = s.distanceM[i]
    if (d !== null && d > run) run = d
    at[i] = run
  }
  const domain = at.length ? at[at.length - 1] : 0
  if (!(domain > 0)) return null
  const toAxis = (sec: number): number => {
    const i = Math.max(0, sampleIndexAt(s, sec))
    const j = Math.min(at.length - 1, i + 1)
    if (j === i || sec <= s.t[i]) return at[i]
    return at[i] + (at[j] - at[i]) * Math.min(1, (sec - s.t[i]) / (s.t[j] - s.t[i]))
  }
  /** The FIRST moment the distance reached `x`: a stop (distance standing
   *  still) collapses to its start. */
  const toSec = (x: number): number => {
    const d = clamp(x, 0, domain)
    let lo = 0
    let hi = at.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (at[mid] >= d) hi = mid
      else lo = mid + 1
    }
    if (lo === 0) return s.t[0]
    const f = (d - at[lo - 1]) / (at[lo] - at[lo - 1])
    return s.t[lo - 1] + f * (s.t[lo] - s.t[lo - 1])
  }
  return { axis, domain, minSpan: MIN_SPAN.distance, at, toAxis, toSec }
}

// --- The view (what part of the axis is shown) ----------------------------------

export interface GraphView {
  x0: number
  x1: number
}

/** `v` kept inside `[0, domain]`, never narrower than `minSpan` (nor wider than the domain). */
export function clampView(v: GraphView, domain: number, minSpan: number): GraphView {
  const span = clamp(v.x1 - v.x0, Math.min(minSpan, domain), domain)
  const x0 = clamp(v.x0, 0, Math.max(0, domain - span))
  return { x0, x1: x0 + span }
}

/** Zoom by `factor` (< 1 = in) keeping axis point `at` where it is on screen. */
export function zoomView(v: GraphView, at: number, factor: number, domain: number, minSpan: number): GraphView {
  const span = clamp((v.x1 - v.x0) * factor, Math.min(minSpan, domain), domain)
  const f = v.x1 > v.x0 ? (at - v.x0) / (v.x1 - v.x0) : 0.5
  return clampView({ x0: at - f * span, x1: at - f * span + span }, domain, minSpan)
}

/** Slide the view by `delta` axis units. */
export function panView(v: GraphView, delta: number, domain: number, minSpan: number): GraphView {
  return clampView({ x0: v.x0 + delta, x1: v.x1 + delta }, domain, minSpan)
}

// --- Drawing --------------------------------------------------------------------

export interface LinePoint {
  /** Pixels from the graph's left edge. */
  x: number
  value: number
}

/**
 * A channel as points across a `widthPx`-wide graph showing `view`. Every
 * sample in view (and one either side, so the line runs to the edges) when
 * there are few; when there are more than two per pixel, each pixel column's
 * lowest and highest value, in the order they came, so a 3-hour recording
 * keeps its spikes without drawing 10k points. A sample with no value breaks
 * nothing: it is left out.
 */
export function linePoints(
  values: (number | null)[] | undefined,
  map: AxisMap,
  view: GraphView,
  widthPx: number
): LinePoint[] {
  if (!values || widthPx <= 0 || !(view.x1 > view.x0)) return []
  const k = widthPx / (view.x1 - view.x0)
  const px = (a: number): number => (a - view.x0) * k
  const first = Math.max(0, lowerBound(map.at, view.x0) - 1)
  const last = Math.min(map.at.length - 1, lowerBound(map.at, view.x1))
  const out: LinePoint[] = []
  if (last - first + 1 <= widthPx * 2) {
    for (let i = first; i <= last; i++) {
      const v = values[i]
      if (v !== null && Number.isFinite(v)) out.push({ x: px(map.at[i]), value: v })
    }
    return out
  }
  // NaN matches no column: the sample just left of the view (column −1) opens
  // the first bucket like any other.
  let col = NaN
  let lo: LinePoint | null = null
  let hi: LinePoint | null = null
  const flush = (): void => {
    if (!lo || !hi) return
    if (lo === hi) out.push(lo)
    else out.push(...(lo.x <= hi.x ? [lo, hi] : [hi, lo]))
  }
  for (let i = first; i <= last; i++) {
    const v = values[i]
    if (v === null || !Number.isFinite(v)) continue
    const p = { x: px(map.at[i]), value: v }
    const c = Math.floor(p.x)
    if (c !== col) {
      flush()
      col = c
      lo = hi = p
    } else {
      if (v < lo!.value) lo = p
      if (v > hi!.value) hi = p
    }
  }
  flush()
  return out
}

/** First index whose value is ≥ `x` in a non-decreasing array. */
function lowerBound(a: number[], x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The values' range with a little room above and below (a flat line sits in
 *  the middle), for the line's own vertical scale. */
export function valueRange(points: LinePoint[]): { lo: number; hi: number } {
  if (!points.length) return { lo: 0, hi: 1 }
  let lo = Infinity
  let hi = -Infinity
  for (const p of points) {
    if (p.value < lo) lo = p.value
    if (p.value > hi) hi = p.value
  }
  const pad = hi > lo ? (hi - lo) * 0.08 : Math.max(1, Math.abs(hi) * 0.1)
  return { lo: lo - pad, hi: hi + pad }
}

// --- Ticks ------------------------------------------------------------------------

export interface Tick {
  /** Axis units. */
  at: number
  label: string
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400]
const DIST_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100]
const METERS_PER_MILE = 1609.344

/** "1:02:03" / "2:03" / "0:05". */
export function clockLabel(sec: number): string {
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor(t / 60) % 60
  const s = (t % 60).toString().padStart(2, '0')
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Tick marks at a round step, about one per `spacingPx` across the graph. */
export function graphTicks(
  view: GraphView,
  axis: GraphAxis,
  widthPx: number,
  units: DistanceUnits,
  spacingPx = 110
): Tick[] {
  const span = view.x1 - view.x0
  if (!(span > 0) || widthPx <= 0) return []
  const per = units === 'imperial' ? METERS_PER_MILE : 1000
  const want = (span / widthPx) * spacingPx // axis units between ticks
  // Distance steps are picked in miles / km, so the label knows its decimals.
  const unitStep = axis === 'time' ? 1 : (DIST_STEPS.find((d) => d * per >= want) ?? DIST_STEPS[DIST_STEPS.length - 1])
  const step =
    axis === 'time' ? (TIME_STEPS.find((t) => t >= want) ?? TIME_STEPS[TIME_STEPS.length - 1]) : unitStep * per
  const decimals = unitStep >= 1 ? 0 : Number.isInteger(Math.round(unitStep * 1000) / 100) ? 1 : 2
  const out: Tick[] = []
  for (let k = Math.ceil(view.x0 / step - 1e-9); k * step <= view.x1 + 1e-9; k++) {
    const a = k * step
    const label =
      axis === 'time' ? clockLabel(a) : `${(k * unitStep).toFixed(decimals)} ${units === 'imperial' ? 'mi' : 'km'}`
    out.push({ at: a, label })
  }
  return out
}
