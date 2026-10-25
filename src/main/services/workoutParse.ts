/**
 * Decode a `.fit` activity file into the editor's `WorkoutSeries`
 * (`shared/workout.ts`) with Garmin's FIT SDK. `decodeWorkout` is the SDK
 * boundary; `seriesFromMessages` turns the decoded messages into aligned
 * arrays and is pure (unit-tested with hand-built messages). The rules it
 * follows were checked against real files — Garmin Edge and Forerunner,
 * Zwift, TrainingPeaks Virtual — see docs/WORKOUT-OVERLAY.md "FIT files".
 */

import { promises as fsp } from 'node:fs'
import { Decoder, Stream } from '@garmin/fitsdk'
import type { ProbeInfo } from '@shared/media'
import type { WorkoutLeg, WorkoutSeries, WorkoutSpan } from '@shared/workout'
import { summarizeWorkout, workoutDurationSec, WORKOUT_SERIES_VERSION } from '@shared/workout'
import { createLogger } from '@shared/log'
import { PROBE_VERSION } from './ffprobeParse'

const log = createLogger('workout')

/** The decoded fields this file reads (the SDK's camelCase names, with its
 *  default scale/offset applied and date-times converted to `Date` — so a
 *  number where a date belongs is not trusted). */
export interface FitRecord {
  timestamp?: Date
  positionLat?: number
  positionLong?: number
  distance?: number
  speed?: number
  enhancedSpeed?: number
  power?: number
  heartRate?: number
  cadence?: number
  altitude?: number
  enhancedAltitude?: number
}

interface FitTimed {
  startTime?: Date
  totalElapsedTime?: number
}

export interface FitMessages {
  fileIdMesgs?: { type?: string | number }[]
  recordMesgs?: FitRecord[]
  sessionMesgs?: (FitTimed & { sport?: string | number })[]
  lapMesgs?: FitTimed[]
  eventMesgs?: { timestamp?: Date; event?: string | number; eventType?: string | number }[]
}

/** Semicircles (FIT's position unit) → degrees. */
const SEMICIRCLE_DEG = 180 / 2 ** 31

const ms = (d: Date | undefined): number | null => {
  const v = d instanceof Date ? d.getTime() : NaN
  return Number.isFinite(v) ? v : null
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Rounded to `dp` decimals (keeps `workout.json` small; null stays null). */
const round = (v: number | null, dp: number): number | null => {
  if (v === null) return null
  const k = 10 ** dp
  return Math.round(v * k) / k
}

/**
 * The recording as aligned arrays. Throws, in words for the user, for a FIT
 * file that holds no recording — a PLANNED workout (TrainingPeaks exports
 * those as `.fit` too), settings — and for a COURSE, whose samples are a
 * planned route with made-up times, not something that happened.
 */
export function seriesFromMessages(m: FitMessages): WorkoutSeries {
  if (m.fileIdMesgs?.[0]?.type === 'course')
    throw new Error('This FIT file is a course (a planned route), not a recorded workout.')
  const recs = (m.recordMesgs ?? [])
    .map((r) => ({ r, at: ms(r.timestamp) }))
    .filter((x): x is { r: FitRecord; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at)
  if (!recs.length) {
    const type = m.fileIdMesgs?.[0]?.type
    if (type === 'workout')
      throw new Error('This FIT file is a planned workout, not a recorded one: it has no data to show.')
    throw new Error('This FIT file has no recorded samples (it may be a course or settings file).')
  }
  const t0 = recs[0].at

  // FIT timestamps are whole seconds, but some apps write several samples in
  // one second (TrainingPeaks Virtual, with the distance still advancing).
  // Spread each run of equal timestamps evenly across its second instead of
  // dropping all but one: the samples are real movement.
  const t: number[] = new Array(recs.length)
  for (let i = 0; i < recs.length;) {
    let j = i
    while (j + 1 < recs.length && recs[j + 1].at === recs[i].at) j++
    const n = j - i + 1
    for (let k = 0; k < n; k++) t[i + k] = round((recs[i].at - t0) / 1000 + k / n, 3)!
    i = j + 1
  }

  const column = (pick: (r: FitRecord) => number | null, dp: number): (number | null)[] =>
    recs.map(({ r }) => round(pick(r), dp))
  const lat = column((r) => {
    const v = finite(r.positionLat)
    return v === null ? null : v * SEMICIRCLE_DEG
  }, 6)
  const lon = column((r) => {
    const v = finite(r.positionLong)
    return v === null ? null : v * SEMICIRCLE_DEG
  }, 6)
  // A position is only real with both halves, inside the globe.
  for (let i = 0; i < lat.length; i++) {
    const a = lat[i]
    const b = lon[i]
    if (a === null || b === null || Math.abs(a) > 90 || Math.abs(b) > 180) lat[i] = lon[i] = null
  }

  const series: WorkoutSeries = {
    version: WORKOUT_SERIES_VERSION,
    startUtc: new Date(t0).toISOString(),
    t,
    legs: [],
    laps: [],
    pauses: []
  }
  if (lat.filter((v) => v !== null).length >= 2) {
    series.lat = lat
    series.lon = lon
  }
  // Kept only when the file really carries the channel: an indoor ride logs
  // distance 0 throughout, a watch without a strap logs heart rate 0.
  const keep = (values: (number | null)[], real: (v: number) => boolean): (number | null)[] | undefined =>
    values.some((v) => v !== null && real(v)) ? values : undefined
  const positive = (v: number): boolean => v > 0
  series.distanceM = keep(
    column((r) => finite(r.distance), 2),
    positive
  )
  series.speedMps = keep(
    column((r) => finite(r.enhancedSpeed) ?? finite(r.speed), 3),
    positive
  )
  series.powerW = keep(
    column((r) => finite(r.power), 0),
    positive
  )
  series.heartRate = keep(
    column((r) => finite(r.heartRate), 0),
    positive
  )
  series.cadence = keep(
    column((r) => finite(r.cadence), 0),
    positive
  )
  series.altitudeM = keep(
    column((r) => finite(r.enhancedAltitude) ?? finite(r.altitude), 1),
    () => true
  )
  for (const key of ['distanceM', 'speedMps', 'powerW', 'heartRate', 'cadence', 'altitudeM'] as const) {
    if (!series[key]) delete series[key]
  }

  const end = t[t.length - 1]
  const span = (x: FitTimed): WorkoutSpan | null => {
    const start = ms(x.startTime)
    const len = finite(x.totalElapsedTime)
    if (start === null || len === null || !(len > 0)) return null
    // A leg or lap may start before the first sample (TrainingPeaks: by 2
    // minutes); it still ENDS where its own length says, not that much later.
    const from = (start - t0) / 1000
    const startSec = Math.max(0, from)
    const endSec = Math.min(end, from + len)
    return endSec > startSec ? { startSec: round(startSec, 3)!, endSec: round(endSec, 3)! } : null
  }
  series.legs = (m.sessionMesgs ?? [])
    .flatMap((s): WorkoutLeg[] => {
      const at = span(s)
      return at ? [{ ...at, sport: typeof s.sport === 'string' ? s.sport : 'workout' }] : []
    })
    .sort((a, b) => a.startSec - b.startSec)
  series.laps = (m.lapMesgs ?? [])
    .map(span)
    .filter((x): x is WorkoutSpan => x !== null)
    .sort((a, b) => a.startSec - b.startSec)
  series.pauses = timerPauses(m.eventMesgs ?? [], t0, end)
  return series
}

/** Where the timer was stopped: each timer `stop`/`stopAll` to the next timer
 *  `start`, inside the recording. A stop and start in the same second (some
 *  apps write that pair at every lap) is no pause. */
function timerPauses(events: NonNullable<FitMessages['eventMesgs']>, t0: number, end: number): WorkoutSpan[] {
  const timer = events
    .map((e) => ({ at: ms(e.timestamp), type: e.eventType, event: e.event }))
    .filter((e): e is { at: number; type: string; event: string } => e.at !== null && e.event === 'timer')
    .sort((a, b) => a.at - b.at)
  const pauses: WorkoutSpan[] = []
  let stoppedAt: number | null = null
  for (const e of timer) {
    if (e.type === 'stop' || e.type === 'stopAll') stoppedAt ??= e.at
    else if (e.type === 'start' && stoppedAt !== null) {
      const startSec = Math.max(0, (stoppedAt - t0) / 1000)
      const endSec = Math.min(end, (e.at - t0) / 1000)
      if (endSec - startSec >= 1) pauses.push({ startSec, endSec })
      stoppedAt = null
    }
  }
  return pauses
}

/** Decode FIT bytes. A file the SDK reads only partly (a recording cut short
 *  by a crash or a flat battery) still gives the samples before the damage. */
export function decodeWorkout(bytes: Uint8Array): WorkoutSeries {
  const stream = Stream.fromBuffer(bytes)
  if (!Decoder.isFIT(stream)) throw new Error("This file isn't a FIT file.")
  const { messages, errors } = new Decoder(stream).read()
  if (errors.length) log.warn(`FIT decode reported ${errors.length} error(s); keeping what was read`, errors[0])
  return seriesFromMessages(messages as FitMessages)
}

export async function readWorkout(path: string): Promise<WorkoutSeries> {
  return decodeWorkout(await fsp.readFile(path))
}

/** A workout's library probe: no streams, its recorded span as the duration,
 *  and the summary the library describes it by. */
export function workoutProbe(series: WorkoutSeries): ProbeInfo {
  return {
    durationSec: workoutDurationSec(series),
    container: 'fit',
    video: null,
    audio: null,
    version: PROBE_VERSION,
    workout: summarizeWorkout(series)
  }
}
