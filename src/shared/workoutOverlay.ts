/**
 * The WORKOUT OVERLAY (docs/WORKOUT-OVERLAY.md): a timeline tile that shows a
 * stretch of a recorded workout — its RIDE window `[inSec, outSec)` (seconds of
 * the recording) played at `speed` ride-seconds per timeline second — as
 * widgets placed on the frame: numbers (power, speed, heart rate, distance …)
 * and maps of the route.
 *
 * Everything that decides what the overlay shows lives here, pure, so the
 * preview and the export can't disagree:
 *  - the ride-time mapping and the trim / split / speed edits (`workoutRideSec`,
 *    `trimWorkoutStart`, `splitWorkout`, …) — never re-derived inline;
 *  - the METRIC REGISTRY (`WORKOUT_METRICS`): one entry per thing a widget can
 *    show, saying which recorded channels it needs and drawing itself as
 *    `MarkShape`s. A new metric is one entry (`numberMetric` for a readout);
 *  - `workoutOverlayShapes`, what the whole overlay draws at a moment — the
 *    preview renders its SVG, and the export's Chromium rasterises the same
 *    SVG for every output frame.
 */

import type { MarkShape } from './graphics'
import { pathD } from './graphics'
import { FRAME } from './frame'
import { clamp } from './math'
import type { Layer, VideoContent } from './project'
import { videoSpeed } from './project'
import { hasSpeedRamp } from './speed'
import type { DistanceUnits, RoutePoint, RouteProject, WorkoutChannel, WorkoutSeries, WorkoutSummary } from './workout'
import {
  DEFAULT_DISTANCE_UNITS,
  meanAround,
  positionAt,
  routeProjection,
  sampleIndexAt,
  sportAt,
  summarizeWorkout,
  valueAt
} from './workout'

export type WorkoutMetricId =
  'power' | 'speed' | 'heartRate' | 'distance' | 'totalDistance' | 'avgPower' | 'staticMap' | 'liveMap'

/** One thing the overlay shows, placed on the frame. */
export interface WorkoutWidget {
  id: string
  metric: WorkoutMetricId
  /** Centre, in canonical px. */
  x: number
  y: number
  /** A readout's number height, or a map's box width (canonical px). */
  sizePx: number
  color: string
  /** Live map: the part ridden so far drawn bold over the whole route drawn
   *  faint (the route "draws itself"). Absent = the whole route, plain. */
  trace?: boolean
}

/** What a workout tile carries (`LayerContent` kind `workout`). */
export interface WorkoutContentFields {
  mediaId: string
  /** The ride window shown, in seconds of the recording. */
  inSec: number
  outSec: number
  /** Ride seconds per timeline second (1 = real time). The tile lasts
   *  `(outSec − inSec) / speed` — `workoutPlayedSec`. */
  speed: number
  widgets: WorkoutWidget[]
  /** Absent = `DEFAULT_DISTANCE_UNITS`. */
  units?: DistanceUnits
}

// --- Timing -------------------------------------------------------------------

export const MIN_WORKOUT_SPEED = 0.25
export const MAX_WORKOUT_SPEED = 20000
/** Shortest tile (timeline seconds), as for any layer. */
export const MIN_WORKOUT_TILE_SEC = 0.2
/** A new overlay that isn't synced to footage shows the whole recording in this long. */
export const WHOLE_WORKOUT_SEC = 8

/** The tile's effective speed: its `speed`, clamped. */
export function workoutSpeed(c: Pick<WorkoutContentFields, 'speed'>): number {
  const s = c.speed
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return 1
  return clamp(s, MIN_WORKOUT_SPEED, MAX_WORKOUT_SPEED)
}

/** A speed for a badge or a field: "2.5", "120", "1350" (no long decimals). */
export function formatSpeed(speed: number): string {
  return speed < 10 ? (Math.round(speed * 100) / 100).toString() : Math.round(speed).toString()
}

/** Timeline seconds the tile lasts. */
export const workoutPlayedSec = (c: Pick<WorkoutContentFields, 'inSec' | 'outSec' | 'speed'>): number =>
  Math.max(0, c.outSec - c.inSec) / workoutSpeed(c)

/** The moment of the recording shown at timeline time `t` (held at the window's ends). */
export function workoutRideSec(c: WorkoutContentFields, layer: Pick<Layer, 'startSec'>, t: number): number {
  return clamp(c.inSec + (t - layer.startSec) * workoutSpeed(c), c.inSec, c.outSec)
}

/** The timeline time showing moment `rideSec` of the recording (the graph's
 *  cut point on the tile). */
export function workoutTimelineSec(c: WorkoutContentFields, layer: Pick<Layer, 'startSec'>, rideSec: number): number {
  return layer.startSec + (rideSec - c.inSec) / workoutSpeed(c)
}

/** Every edit below takes the tile and its content (narrowed by the caller,
 *  as `trimVideoStart` does) and returns the tile with its end following the
 *  window: `endSec − startSec = workoutPlayedSec(content)` always holds. */
type WorkoutPatch = Partial<WorkoutContentFields>

const withContent = (layer: Layer, c: WorkoutContentFields, patch: WorkoutPatch, startSec = layer.startSec): Layer => {
  const content = { ...c, ...patch, kind: 'workout' as const }
  return { ...layer, startSec, endSec: startSec + workoutPlayedSec(content), content }
}

/** Move the tile's LEFT edge by `deltaSec` of timeline: the ride window's start
 *  moves with it at the tile's speed (never before the recording's start, nor
 *  the tile before timeline 0). */
export function trimWorkoutStart(layer: Layer, c: WorkoutContentFields, deltaSec: number): Layer {
  const speed = workoutSpeed(c)
  const d = Math.max(deltaSec, -layer.startSec)
  const inSec = clamp(c.inSec + d * speed, 0, Math.max(c.inSec, c.outSec - MIN_WORKOUT_TILE_SEC * speed))
  return withContent(layer, c, { inSec }, layer.startSec + (inSec - c.inSec) / speed)
}

/** Move the tile's RIGHT edge by `deltaSec` of timeline, up to the end of the
 *  recording (`rideDurSec`; 0 = unknown, no cap). */
export function trimWorkoutEnd(layer: Layer, c: WorkoutContentFields, deltaSec: number, rideDurSec: number): Layer {
  const speed = workoutSpeed(c)
  const max = Math.max(c.outSec, rideDurSec > 0 ? rideDurSec : Infinity)
  // The shortest tile, but never past the recording's end (a tile already
  // shorter than that, from an old speed, just can't shrink).
  const min = Math.min(c.inSec + MIN_WORKOUT_TILE_SEC * speed, c.outSec)
  const outSec = clamp(c.outSec + deltaSec * speed, min, max)
  return withContent(layer, c, { outSec })
}

/** Split at timeline time `atSec` into two tiles over consecutive ride windows
 *  at the same speed (null when the cut misses the tile). The right half's
 *  widgets get fresh ids. */
export function splitWorkout(
  layer: Layer,
  c: WorkoutContentFields,
  atSec: number,
  makeId: () => string
): [Layer, Layer] | null {
  if (atSec <= layer.startSec + 1e-6 || atSec >= layer.endSec - 1e-6) return null
  const cut = workoutRideSec(c, layer, atSec)
  const left = withContent(layer, c, { outSec: cut })
  const right = withContent(
    { ...layer, id: makeId() },
    c,
    { inSec: cut, widgets: c.widgets.map((w) => ({ ...w, id: makeId() })) },
    atSec
  )
  return [left, right]
}

/** A new speed, the ride window kept: the tile's end follows. Never so fast
 *  that the tile would be shorter than `MIN_WORKOUT_TILE_SEC`. */
export function withWorkoutSpeed(layer: Layer, c: WorkoutContentFields, speed: number): Layer {
  const fastest = Math.max(MIN_WORKOUT_SPEED, Math.min(MAX_WORKOUT_SPEED, (c.outSec - c.inSec) / MIN_WORKOUT_TILE_SEC))
  return withContent(layer, c, { speed: clamp(speed, MIN_WORKOUT_SPEED, fastest) })
}

/** The speed that plays the ride window in `sec` of timeline. */
export function withWorkoutDuration(layer: Layer, c: WorkoutContentFields, sec: number): Layer {
  return withWorkoutSpeed(layer, c, (c.outSec - c.inSec) / Math.max(MIN_WORKOUT_TILE_SEC, sec))
}

/** Slide the ride window to start at `inSec` (same length, same tile): what
 *  lines a synced overlay up with its footage by hand. */
export function slipWorkout(layer: Layer, c: WorkoutContentFields, inSec: number, rideDurSec: number): Layer {
  const len = c.outSec - c.inSec
  const start = clamp(inSec, 0, rideDurSec > 0 ? Math.max(0, rideDurSec - len) : Infinity)
  return withContent(layer, c, { inSec: start, outSec: start + len })
}

// --- Syncing to footage --------------------------------------------------------

/** A video tile the overlay could line up with: where it sits, and the wall
 *  clock time of its first SHOWN frame (its recording time plus its in-point). */
export interface SyncClip {
  startSec: number
  endSec: number
  shownFromUtcMs: number
}

/** The video clip a workout placed at `atSec` would sync to: the topmost
 *  visible one there, if it plays at real time (no speed change, ramp or
 *  freeze — its frames then map one-to-one onto wall-clock time). Its media
 *  must also be an ORIGINAL (`canSyncTo`). */
export function syncCandidate(layers: Layer[], atSec: number): (Layer & { content: VideoContent }) | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]
    const c = l.content
    if (l.hidden || c.kind !== 'video' || atSec < l.startSec || atSec >= l.endSec) continue
    if (videoSpeed(c) !== 1 || hasSpeedRamp(c) || (c.freezes?.length ?? 0) > 0) return null
    return { ...l, content: c }
  }
  return null
}

/**
 * Whether a library item's recording time can be trusted to say when its
 * first frame was filmed: only for an original. A clip the editor made (a
 * Quick-cut piece, a merge, a background removal) carries the tags of the file
 * it was cut from — `-map_metadata 0` — so a piece taken 30 s into a clip still
 * claims the original's start (FFMPEG-NOTES "Recording time").
 */
export function canSyncTo(asset: { generated?: boolean; probe: { video: unknown } }): boolean {
  return !!asset.probe.video && !asset.generated
}

/**
 * The overlay that shows the recording exactly as it was while `clip` was
 * filmed: same window on the timeline, real time (speed 1). Trimmed to the part
 * of the clip the recording covers; null when they don't overlap at all (the
 * clip was filmed at another time).
 */
export function syncedWindow(
  startUtc: string,
  rideDurSec: number,
  clip: SyncClip
): { startSec: number; inSec: number; outSec: number } | null {
  const t0 = Date.parse(startUtc)
  if (!Number.isFinite(t0) || !Number.isFinite(clip.shownFromUtcMs)) return null
  const rideAtStart = (clip.shownFromUtcMs - t0) / 1000
  const inSec = Math.max(0, rideAtStart)
  const outSec = Math.min(rideDurSec, rideAtStart + (clip.endSec - clip.startSec))
  if (outSec - inSec < MIN_WORKOUT_TILE_SEC) return null
  return { startSec: clip.startSec + (inSec - rideAtStart), inSec, outSec }
}

// --- Widgets ------------------------------------------------------------------

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** What a metric draws from at one moment. */
export interface MetricContext {
  series: WorkoutSeries
  summary: WorkoutSummary
  /** The moment of the recording shown. */
  rideSec: number
  /** Half the smoothing window, in ride seconds (0 = the raw sample). */
  smoothHalfSec: number
  units: DistanceUnits
}

export interface WorkoutMetric {
  id: WorkoutMetricId
  /** The Inspector's name for it. */
  label: string
  /** Recorded channels it needs; without them it can't be shown. */
  needs: WorkoutChannel[]
  kind: 'number' | 'map'
  defaultSizePx: number
  /** False = one value for the whole workout (a total, an average). */
  live: boolean
  draw(ctx: MetricContext, w: WorkoutWidget): MarkShape[]
  /** The canonical-px box it draws inside (hit area, the export's crop). */
  bounds(w: WorkoutWidget): Box
}

/** What a readout shows: the number, and the small line under it. */
export interface Reading {
  value: string
  unit: string
}

/** A channel's value at the moment shown: the sample at or before it (raw),
 *  or the mean around it when the overlay plays fast. */
function sampled(ctx: MetricContext, values: (number | null)[] | undefined): number | null {
  if (!values) return null
  if (ctx.smoothHalfSec > 0) return meanAround(ctx.series, values, ctx.rideSec, ctx.smoothHalfSec)
  const i = sampleIndexAt(ctx.series, ctx.rideSec)
  return values[Math.max(0, i)] ?? null
}

/** A readout: the number centred on the widget, its unit under it. */
function readoutShapes(w: WorkoutWidget, r: Reading | null): MarkShape[] {
  const outline = Math.max(2, w.sizePx * 0.05)
  return [
    {
      kind: 'label',
      x: w.x,
      y: w.y,
      text: r?.value ?? '--',
      fontSizePx: w.sizePx,
      color: w.color,
      outlinePx: outline,
      tabular: true
    },
    {
      kind: 'label',
      x: w.x,
      y: w.y + w.sizePx * 0.78,
      text: r?.unit ?? '',
      fontSizePx: w.sizePx * 0.32,
      color: w.color,
      outlinePx: outline * 0.6
    }
  ]
}

/** A readout metric: `read` gives its number at the moment (null = no value there). */
export function numberMetric(
  id: WorkoutMetricId,
  label: string,
  needs: WorkoutChannel[],
  live: boolean,
  read: (ctx: MetricContext) => Reading | null
): WorkoutMetric {
  return {
    id,
    label,
    needs,
    kind: 'number',
    defaultSizePx: 96,
    live,
    draw: (ctx, w) => readoutShapes(w, read(ctx)),
    // Wide enough for "33.21" in the bundled face; tall enough for the unit line.
    bounds: (w) => ({ x: w.x - w.sizePx * 1.9, y: w.y - w.sizePx * 0.65, w: w.sizePx * 3.8, h: w.sizePx * 1.65 })
  }
}

const METERS_PER_MILE = 1609.344
const METERS_PER_YARD = 0.9144

/** "7:42" from seconds. */
const minSec = (sec: number): string => {
  const total = Math.round(sec)
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

/** Speed the way the sport reads it: pace for a run or a swim, speed otherwise. */
export function speedReading(mps: number | null, sport: string, units: DistanceUnits): Reading {
  const imperial = units === 'imperial'
  if (sport === 'running' || sport === 'walking' || sport === 'hiking') {
    const unit = imperial ? '/MI' : '/KM'
    // Slower than 30 min/mi is standing, not a pace.
    if (mps === null || mps < 0.9) return { value: '--', unit }
    return { value: minSec((imperial ? METERS_PER_MILE : 1000) / mps), unit }
  }
  if (sport === 'swimming') {
    const unit = imperial ? '/100YD' : '/100M'
    if (mps === null || mps < 0.2) return { value: '--', unit }
    return { value: minSec((imperial ? 100 * METERS_PER_YARD : 100) / mps), unit }
  }
  const unit = imperial ? 'MPH' : 'KM/H'
  if (mps === null) return { value: '--', unit }
  return { value: (mps * (imperial ? 3600 / METERS_PER_MILE : 3.6)).toFixed(1), unit }
}

/** A distance as a readout number: miles / km to two places under 10, one above. */
export function distanceReading(m: number | null, units: DistanceUnits, unitSuffix = ''): Reading {
  const unit = (units === 'imperial' ? 'MI' : 'KM') + unitSuffix
  if (m === null) return { value: '--', unit }
  const v = units === 'imperial' ? m / METERS_PER_MILE : m / 1000
  return { value: v.toFixed(v < 10 ? 2 : 1), unit }
}

const round0 = (v: number | null): string => (v === null ? '--' : Math.round(v).toString())

/** The map's route line width for a box this size. */
const routeWidth = (sizePx: number): number => Math.max(4, sizePx / 55)

/** A route fitted to a map box: its points (an even stride over the track) and
 *  the moment of the recording each was at. Fitted once per series and size —
 *  drawing a frame must not refit 10k points. */
interface FittedRoute {
  project: RouteProject
  pts: RoutePoint[]
  secs: number[]
}

const MAP_POINTS = 1500
const fitted = new WeakMap<WorkoutSeries, Map<number, FittedRoute | null>>()

function fittedRoute(series: WorkoutSeries, size: number): FittedRoute | null {
  let bySize = fitted.get(series)
  if (!bySize) fitted.set(series, (bySize = new Map()))
  if (bySize.has(size)) return bySize.get(size)!
  // A size slider drag asks for every size on the way: keep only the latest few.
  if (bySize.size >= 8) bySize.delete(bySize.keys().next().value!)
  const project = routeProjection(series, size, size)
  let route: FittedRoute | null = null
  if (project && series.lat && series.lon) {
    const idx: number[] = []
    for (let i = 0; i < series.t.length; i++) if (series.lat[i] !== null && series.lon[i] !== null) idx.push(i)
    const stride = Math.max(1, Math.ceil(idx.length / MAP_POINTS))
    const keep = idx.filter((_, j) => j % stride === 0 || j === idx.length - 1)
    route = {
      project,
      pts: keep.map((i) => project(series.lat![i]!, series.lon![i]!)),
      secs: keep.map((i) => series.t[i])
    }
  }
  bySize.set(size, route)
  return route
}

const mapBox = (w: WorkoutWidget): Box => ({ x: w.x - w.sizePx / 2, y: w.y - w.sizePx / 2, w: w.sizePx, h: w.sizePx })

const r2 = (n: number): number => Math.round(n * 100) / 100

/** A filled dot as a path (MarkShape has no circle). */
const dotPath = (cx: number, cy: number, r: number): string =>
  `M${r2(cx - r)} ${r2(cy)} a${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0 a${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0 Z`

/** The colour at a lower opacity (`#rrggbb` → `#rrggbbaa`). */
const faint = (color: string): string => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}55` : color)

function mapMetric(id: 'staticMap' | 'liveMap', label: string): WorkoutMetric {
  return {
    id,
    label,
    needs: ['position'],
    kind: 'map',
    defaultSizePx: 420,
    live: id === 'liveMap',
    bounds: (w) => {
      const b = mapBox(w)
      // The dot (radius size/28 plus its outline) can sit on the route's edge.
      const m = w.sizePx * 0.06
      return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m }
    },
    draw: (ctx, w) => {
      const route = fittedRoute(ctx.series, w.sizePx)
      if (!route) return []
      const box = mapBox(w)
      const placed = (pts: RoutePoint[]): string => pathD(pts.map((p) => ({ x: box.x + p.x, y: box.y + p.y })))
      const width = routeWidth(w.sizePx)
      const line = (pts: RoutePoint[], stroke: string, sw: number): MarkShape => ({
        kind: 'path',
        d: placed(pts),
        stroke,
        strokeWidth: sw,
        fill: null
      })
      if (id === 'staticMap') return [line(route.pts, w.color, width)]
      const at = positionAt(ctx.series, ctx.rideSec)
      const here = at ? route.project(at.lat, at.lon) : null
      const shapes: MarkShape[] = []
      if (w.trace) {
        // The ridden part: every point up to now, then exactly where the dot is.
        const ridden = route.pts.filter((_, i) => route.secs[i] <= ctx.rideSec)
        if (here) ridden.push(here)
        shapes.push(line(route.pts, faint(w.color), width))
        if (ridden.length > 1) shapes.push(line(ridden, w.color, width * 1.4))
      } else shapes.push(line(route.pts, w.color, width))
      if (here) {
        const r = Math.max(9, w.sizePx / 28)
        shapes.push({
          kind: 'path',
          d: dotPath(box.x + here.x, box.y + here.y, r),
          stroke: '#000000',
          strokeWidth: r * 0.35,
          fill: DOT_COLOR
        })
      }
      return shapes
    }
  }
}

const DOT_COLOR = '#FFD60A'

/** Every metric a widget can show. Order = the Inspector's order. */
export const WORKOUT_METRICS: Record<WorkoutMetricId, WorkoutMetric> = {
  power: numberMetric('power', 'Power', ['power'], true, (ctx) => ({
    value: round0(sampled(ctx, ctx.series.powerW)),
    unit: 'W'
  })),
  speed: numberMetric('speed', 'Speed / pace', ['speed'], true, (ctx) =>
    speedReading(sampled(ctx, ctx.series.speedMps), sportAt(ctx.series, ctx.rideSec), ctx.units)
  ),
  heartRate: numberMetric('heartRate', 'Heart rate', ['heartRate'], true, (ctx) => ({
    value: round0(sampled(ctx, ctx.series.heartRate)),
    unit: 'BPM'
  })),
  distance: numberMetric('distance', 'Distance so far', ['distance'], true, (ctx) =>
    distanceReading(valueAt(ctx.series, ctx.series.distanceM, ctx.rideSec), ctx.units)
  ),
  totalDistance: numberMetric('totalDistance', 'Total distance', ['distance'], false, (ctx) =>
    distanceReading(ctx.summary.distanceM, ctx.units, ' TOTAL')
  ),
  avgPower: numberMetric('avgPower', 'Average power', ['power'], false, (ctx) => ({
    value: round0(ctx.summary.avgPowerW),
    unit: 'AVG W'
  })),
  staticMap: mapMetric('staticMap', 'Static map'),
  liveMap: mapMetric('liveMap', 'Live map')
}

export const WORKOUT_METRIC_IDS = Object.keys(WORKOUT_METRICS) as WorkoutMetricId[]

const CHANNEL_WORDS: Record<WorkoutChannel, string> = {
  position: 'GPS track',
  distance: 'distance',
  speed: 'speed',
  power: 'power',
  heartRate: 'heart rate',
  cadence: 'cadence',
  altitude: 'elevation'
}

/** Why `metric` can't be shown for a file with these channels, or null. */
export function metricMissing(metric: WorkoutMetricId, channels: readonly WorkoutChannel[]): string | null {
  const missing = WORKOUT_METRICS[metric].needs.filter((c) => !channels.includes(c))
  return missing.length ? `This file has no ${missing.map((c) => CHANNEL_WORDS[c]).join(' or ')}.` : null
}

/** Where widgets go when added: readouts along the lower third, maps up top.
 *  A slot is taken when a widget of the same kind already sits there. */
const SLOTS: Record<'number' | 'map', { x: number; y: number }[]> = {
  number: [
    { x: 190, y: 1440 },
    { x: 540, y: 1440 },
    { x: 890, y: 1440 },
    { x: 190, y: 1250 },
    { x: 540, y: 1250 },
    { x: 890, y: 1250 }
  ],
  map: [
    { x: 790, y: 480 },
    { x: 290, y: 480 }
  ]
}

export const WIDGET_DEFAULT_COLOR = '#FFFFFF'

/** A new widget for `metric`, in the first free slot of its kind (the frame's
 *  centre when every slot is taken). */
export function newWidget(metric: WorkoutMetricId, existing: WorkoutWidget[], id: string): WorkoutWidget {
  const m = WORKOUT_METRICS[metric]
  const taken = (p: { x: number; y: number }): boolean =>
    existing.some((w) => WORKOUT_METRICS[w.metric].kind === m.kind && Math.hypot(w.x - p.x, w.y - p.y) < 60)
  const slot = SLOTS[m.kind].find((p) => !taken(p)) ?? { x: FRAME.width / 2, y: FRAME.height / 2 }
  return { id, metric, x: slot.x, y: slot.y, sizePx: m.defaultSizePx, color: WIDGET_DEFAULT_COLOR }
}

/** What a new overlay shows: power, speed, heart rate and the live map — those
 *  the file has. */
export function defaultWidgets(channels: readonly WorkoutChannel[], makeId: () => string): WorkoutWidget[] {
  const out: WorkoutWidget[] = []
  for (const metric of ['power', 'speed', 'heartRate', 'liveMap'] as const) {
    if (!metricMissing(metric, channels)) out.push(newWidget(metric, out, makeId()))
  }
  return out
}

// --- Drawing --------------------------------------------------------------------

/** How much screen time each number averages over once the overlay plays fast,
 *  so it reads instead of flickering. At (near) real time it shows the raw sample. */
export const SMOOTH_SCREEN_SEC = 0.5

export function smoothHalfSec(speed: number): number {
  return speed <= 1.5 ? 0 : (speed * SMOOTH_SCREEN_SEC) / 2
}

const summaries = new WeakMap<WorkoutSeries, WorkoutSummary>()
const summaryOf = (s: WorkoutSeries): WorkoutSummary => {
  let v = summaries.get(s)
  if (!v) summaries.set(s, (v = summarizeWorkout(s)))
  return v
}

/** Everything the overlay draws at timeline time `t`, in canonical px. A widget
 *  whose data the file lacks draws nothing. */
export function workoutOverlayShapes(
  c: WorkoutContentFields,
  layer: Pick<Layer, 'startSec'>,
  series: WorkoutSeries,
  t: number
): MarkShape[] {
  const summary = summaryOf(series)
  const ctx: MetricContext = {
    series,
    summary,
    rideSec: workoutRideSec(c, layer, t),
    smoothHalfSec: smoothHalfSec(workoutSpeed(c)),
    units: c.units ?? DEFAULT_DISTANCE_UNITS
  }
  return c.widgets.flatMap((w) =>
    metricMissing(w.metric, summary.channels) ? [] : WORKOUT_METRICS[w.metric].draw(ctx, w)
  )
}

/** The box every widget draws inside (null = no widgets). */
export function workoutOverlayBounds(c: Pick<WorkoutContentFields, 'widgets'>): Box | null {
  if (!c.widgets.length) return null
  const boxes = c.widgets.map((w) => WORKOUT_METRICS[w.metric].bounds(w))
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.w))
  const y1 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
