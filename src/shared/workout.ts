/**
 * A recorded WORKOUT (a `.fit` activity file from a Garmin, Wahoo, Zwift,
 * TrainingPeaks, …) as the editor holds it. Main decodes the file once
 * (`main/services/workoutParse.ts`) into a `WorkoutSeries` — aligned per-sample
 * arrays, kept in the clip's cache as `workout.json` — and a `WorkoutSummary`,
 * which rides in the library record's probe so the library can describe the
 * file without loading the series. docs/WORKOUT-OVERLAY.md has the rules and
 * what was verified against real files.
 *
 * Everything here is pure: the route shape drawn as the library thumbnail is
 * the same `routeShape` the overlay's maps will draw, in the preview and the
 * export alike.
 */

/** A kind of data a recording may or may not carry. `position` = a GPS track. */
export type WorkoutChannel = 'position' | 'distance' | 'speed' | 'power' | 'heartRate' | 'cadence' | 'altitude'

export const WORKOUT_CHANNELS: readonly WorkoutChannel[] = [
  'position',
  'distance',
  'speed',
  'power',
  'heartRate',
  'cadence',
  'altitude'
]

/** A stretch of the recording, in seconds from its first sample. */
export interface WorkoutSpan {
  startSec: number
  endSec: number
}

/** One leg of the recording (a multisport file has one per discipline and
 *  transition). `sport` is the FIT name: `cycling`, `running`, `swimming`,
 *  `transition`, `training`, … */
export interface WorkoutLeg extends WorkoutSpan {
  sport: string
}

/** Bumped when the parser learns something a cached `workout.json` lacks; a
 *  cache with another version is rebuilt from the original. */
export const WORKOUT_SERIES_VERSION = 1

/**
 * The decoded recording. `t` is strictly increasing seconds from the first
 * sample; every channel array present is aligned with it (`null` = no value at
 * that sample). A channel is present only when the file really carries it — an
 * indoor ride's all-zero distance, or a heart rate of 0 throughout (no strap),
 * is left out rather than drawn as a flat line.
 */
export interface WorkoutSeries {
  version: number
  /** Wall-clock time of the first sample (ISO, UTC). */
  startUtc: string
  t: number[]
  /** Degrees (WGS84). Present together, or not at all. */
  lat?: (number | null)[]
  lon?: (number | null)[]
  distanceM?: (number | null)[]
  speedMps?: (number | null)[]
  powerW?: (number | null)[]
  heartRate?: (number | null)[]
  cadence?: (number | null)[]
  altitudeM?: (number | null)[]
  legs: WorkoutLeg[]
  laps: WorkoutSpan[]
  /** Where the device's timer was stopped (auto-pause, a stop at a light). */
  pauses: WorkoutSpan[]
}

/** What the library record keeps about a workout (saved in the `.reel`). */
export interface WorkoutSummary {
  /** One discipline's FIT name, or `multisport` when the file has several. */
  sport: string
  startUtc: string
  channels: WorkoutChannel[]
  /** Total distance covered (m), when the file records distance. */
  distanceM: number | null
  /** Mean of the recorded power samples (W) — what Garmin reports as the
   *  session's average power (checked on real files). */
  avgPowerW: number | null
}

/** Which channels a series carries, in `WORKOUT_CHANNELS` order. */
export function seriesChannels(s: WorkoutSeries): WorkoutChannel[] {
  const has: Record<WorkoutChannel, boolean> = {
    position: !!s.lat && !!s.lon,
    distance: !!s.distanceM,
    speed: !!s.speedMps,
    power: !!s.powerW,
    heartRate: !!s.heartRate,
    cadence: !!s.cadence,
    altitude: !!s.altitudeM
  }
  return WORKOUT_CHANNELS.filter((c) => has[c])
}

const numbers = (xs: (number | null)[] | undefined): number[] =>
  (xs ?? []).filter((x): x is number => x !== null && Number.isFinite(x))

/** Smallest and largest of `xs` (±Infinity when empty) — a loop, because
 *  `Math.min(...xs)` overflows the stack past ~100k values (a long recording). */
function extent(xs: number[]): { lo: number; hi: number } {
  let lo = Infinity
  let hi = -Infinity
  for (const x of xs) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return { lo, hi }
}

/** The sport the file is: its one discipline (transitions don't count), else
 *  `multisport`; a file with no legs is a plain `workout`. */
export function workoutSport(legs: WorkoutLeg[]): string {
  const sports = [...new Set(legs.map((l) => l.sport).filter((s) => s !== 'transition'))]
  if (sports.length === 1) return sports[0]
  return sports.length > 1 ? 'multisport' : 'workout'
}

export function summarizeWorkout(s: WorkoutSeries): WorkoutSummary {
  const distances = numbers(s.distanceM)
  const powers = numbers(s.powerW)
  return {
    sport: workoutSport(s.legs),
    startUtc: s.startUtc,
    channels: seriesChannels(s),
    distanceM: distances.length ? extent(distances).hi : null,
    avgPowerW: powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : null
  }
}

/** Seconds the recording spans, first sample to last. */
export const workoutDurationSec = (s: Pick<WorkoutSeries, 't'>): number => (s.t.length ? s.t[s.t.length - 1] : 0)

// --- Route shape --------------------------------------------------------------

export interface RoutePoint {
  x: number
  y: number
}

/**
 * The GPS track fitted into a `w`×`h` box (inset by `pad`), north up, centred,
 * aspect kept — the route's SHAPE only, no map. Longitude is scaled by the
 * cosine of the track's mean latitude (equirectangular), which is exact enough
 * at the size of one workout. At most `maxPoints` points (an even stride over
 * the track, keeping its last point). Empty when the file has no track or
 * fewer than two positions.
 */
export function routeShape(s: WorkoutSeries, w: number, h: number, pad = 0, maxPoints = 2000): RoutePoint[] {
  if (!s.lat || !s.lon) return []
  const pts: { lat: number; lon: number }[] = []
  for (let i = 0; i < s.t.length; i++) {
    const lat = s.lat[i]
    const lon = s.lon[i]
    if (lat !== null && lon !== null) pts.push({ lat, lon })
  }
  if (pts.length < 2) return []
  const meanLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length
  const k = Math.cos((meanLat * Math.PI) / 180)
  const xs = pts.map((p) => p.lon * k)
  const ys = pts.map((p) => -p.lat)
  const ex = extent(xs)
  const ey = extent(ys)
  const minX = ex.lo
  const minY = ey.lo
  const spanX = ex.hi - minX
  const spanY = ey.hi - minY
  const innerW = Math.max(0, w - 2 * pad)
  const innerH = Math.max(0, h - 2 * pad)
  // A straight north-south (or east-west) track fits on its one real span; a
  // track that never moved is a dot in the middle, not a divide by zero.
  const fit = Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity)
  const scale = Number.isFinite(fit) ? fit : 0
  const offX = pad + (innerW - spanX * scale) / 2
  const offY = pad + (innerH - spanY * scale) / 2
  const stride = Math.max(1, Math.ceil(pts.length / maxPoints))
  const out: RoutePoint[] = []
  for (let i = 0; i < pts.length; i += stride)
    out.push({ x: offX + (xs[i] - minX) * scale, y: offY + (ys[i] - minY) * scale })
  const last = pts.length - 1
  if (last % stride !== 0) out.push({ x: offX + (xs[last] - minX) * scale, y: offY + (ys[last] - minY) * scale })
  return out
}

const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()
const polyline = (pts: RoutePoint[]): string => pts.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ')

/** Thumbnail colours (the library's sky accent on its dark card). */
const ROUTE_COLOR = '#38bdf8'
const START_COLOR = '#34d399'

/** The library thumbnail's size: the card's 9:16 cell, at 5× for sharpness. */
export const WORKOUT_THUMB = { w: 180, h: 320 }

/**
 * The library thumbnail as a standalone SVG document: the route's shape, with
 * a dot where it starts. A file without a track (an indoor ride, a pool swim)
 * shows a sparkline of its power, speed or heart rate instead, and one with
 * none of those just its sport.
 */
export function workoutThumbSvg(s: WorkoutSeries): string {
  const { w, h } = WORKOUT_THUMB
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  const route = routeShape(s, w, h, 18, 400)
  if (route.length) {
    const start = route[0]
    return (
      open +
      `<polyline points="${polyline(route)}" fill="none" stroke="${ROUTE_COLOR}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${f1(start.x)}" cy="${f1(start.y)}" r="9" fill="${START_COLOR}"/></svg>`
    )
  }
  const line = sparkline(s.powerW ?? s.speedMps ?? s.heartRate, s.t, w, h * 0.4, h * 0.3)
  if (line.length) {
    return (
      open +
      `<polyline points="${polyline(line)}" fill="none" stroke="${ROUTE_COLOR}" stroke-width="5" stroke-linejoin="round"/></svg>`
    )
  }
  return (
    open +
    `<text x="${w / 2}" y="${h / 2}" fill="${ROUTE_COLOR}" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" dominant-baseline="middle">FIT</text></svg>`
  )
}

/** A channel drawn across the box's width over time, `height` tall from `top`:
 *  ~90 buckets, each the bucket's mean, so a 3-hour file stays readable. */
function sparkline(
  values: (number | null)[] | undefined,
  t: number[],
  width: number,
  height: number,
  top: number
): RoutePoint[] {
  const end = t.length ? t[t.length - 1] : 0
  if (!values || !(end > 0)) return []
  const buckets = 90
  const sums = new Array<number>(buckets).fill(0)
  const counts = new Array<number>(buckets).fill(0)
  for (let i = 0; i < t.length; i++) {
    const v = values[i]
    if (v === null || !Number.isFinite(v)) continue
    const b = Math.min(buckets - 1, Math.floor((t[i] / end) * buckets))
    sums[b] += v
    counts[b]++
  }
  const means = sums.map((s, i) => (counts[i] ? s / counts[i] : null))
  const known = means.filter((m): m is number => m !== null)
  if (known.length < 2) return []
  const lo = Math.min(...known)
  const span = Math.max(...known) - lo || 1
  const pts: RoutePoint[] = []
  means.forEach((m, i) => {
    if (m !== null) pts.push({ x: (i / (buckets - 1)) * width, y: top + height - ((m - lo) / span) * height })
  })
  return pts
}

// --- Words --------------------------------------------------------------------

export type DistanceUnits = 'imperial' | 'metric'

/** Until the overlay's unit setting exists: the owner's (US) default. */
export const DEFAULT_DISTANCE_UNITS: DistanceUnits = 'imperial'

const METERS_PER_MILE = 1609.344

/** "42.1 mi" / "67.8 km" (one decimal; whole numbers from 100 up). */
export function formatDistance(m: number, units: DistanceUnits = DEFAULT_DISTANCE_UNITS): string {
  const v = units === 'imperial' ? m / METERS_PER_MILE : m / 1000
  const shown = v >= 100 ? Math.round(v).toString() : v.toFixed(1)
  return `${shown} ${units === 'imperial' ? 'mi' : 'km'}`
}

const SPORT_LABELS: Record<string, string> = {
  cycling: 'Ride',
  running: 'Run',
  swimming: 'Swim',
  walking: 'Walk',
  hiking: 'Hike',
  multisport: 'Multisport',
  training: 'Training',
  workout: 'Workout'
}

/** The sport in the library's words ("Ride", "Run", "Multisport", …). */
export function sportLabel(sport: string): string {
  if (SPORT_LABELS[sport]) return SPORT_LABELS[sport]
  // Other FIT sport names are camelCase (`fitnessEquipment`): "Fitness equipment".
  const words = sport.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Workout'
}
