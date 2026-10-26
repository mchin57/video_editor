/**
 * TEST-ONLY: real FIT files written with Garmin's own encoder, so the decoder
 * tests (vitest) and the import specs (e2e) read genuine FIT bytes rather than
 * hand-made message objects.
 */

import { Encoder, Profile, type Mesg } from '@garmin/fitsdk'

export interface FitSample {
  /** Seconds after `start`. */
  sec: number
  lat?: number
  lon?: number
  distanceM?: number
  speedMps?: number
  powerW?: number
  heartRate?: number
  cadence?: number
  altitudeM?: number
}

export interface FitFileSpec {
  start?: Date
  samples: FitSample[]
  sport?: string
  /** Timer stops, `[stopSec, startSec]` after `start`. */
  pauses?: [number, number][]
  /** Where each lap starts (seconds after `start`); absent = one lap. */
  laps?: number[]
  /** `workout` writes a PLANNED workout: a file id and no recording. */
  type?: 'activity' | 'workout'
}

const DEG_SEMICIRCLES = 2 ** 31 / 180

export function buildFitFile(spec: FitFileSpec): Uint8Array {
  const start = spec.start ?? new Date('2026-05-24T13:00:00Z')
  const at = (sec: number): Date => new Date(start.getTime() + sec * 1000)
  const enc = new Encoder()
  // The SDK types each message's fields; written loosely here, as the decoder hands them back.
  const write = (mesgNum: number, mesg: Record<string, unknown>): void => {
    enc.onMesg(mesgNum, mesg as Mesg)
  }
  write(Profile.MesgNum.FILE_ID, {
    manufacturer: 'development',
    product: 1,
    timeCreated: start,
    type: spec.type ?? 'activity'
  })
  if (spec.type === 'workout') return enc.close()

  const last = spec.samples.length ? spec.samples[spec.samples.length - 1].sec : 0
  const timer = (sec: number, eventType: string): void =>
    write(Profile.MesgNum.EVENT, { timestamp: at(sec), event: 'timer', eventType })
  timer(0, 'start')
  const pauses = [...(spec.pauses ?? [])]
  for (const s of spec.samples) {
    while (pauses.length && pauses[0][0] <= s.sec) {
      const [stop, resume] = pauses.shift()!
      timer(stop, 'stop')
      timer(resume, 'start')
    }
    write(Profile.MesgNum.RECORD, {
      timestamp: at(s.sec),
      ...(s.lat !== undefined ? { positionLat: Math.round(s.lat * DEG_SEMICIRCLES) } : {}),
      ...(s.lon !== undefined ? { positionLong: Math.round(s.lon * DEG_SEMICIRCLES) } : {}),
      ...(s.distanceM !== undefined ? { distance: s.distanceM } : {}),
      ...(s.speedMps !== undefined ? { enhancedSpeed: s.speedMps } : {}),
      ...(s.powerW !== undefined ? { power: s.powerW } : {}),
      ...(s.heartRate !== undefined ? { heartRate: s.heartRate } : {}),
      ...(s.cadence !== undefined ? { cadence: s.cadence } : {}),
      ...(s.altitudeM !== undefined ? { enhancedAltitude: s.altitudeM } : {})
    })
  }
  timer(last, 'stopAll')
  const lapStarts = spec.laps ?? [0]
  lapStarts.forEach((from, i) => {
    const to = lapStarts[i + 1] ?? last
    write(Profile.MesgNum.LAP, { timestamp: at(to), startTime: at(from), totalElapsedTime: to - from })
  })
  write(Profile.MesgNum.SESSION, {
    timestamp: at(last),
    startTime: start,
    totalElapsedTime: last,
    sport: spec.sport ?? 'cycling'
  })
  write(Profile.MesgNum.ACTIVITY, { timestamp: at(last), numSessions: 1 })
  return enc.close()
}

/** `n` one-second samples of a ride around a small loop near 43.8° N, with
 *  power, heart rate, cadence, speed, distance and altitude. */
export function loopRide(n: number): FitSample[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI
    return {
      sec: i,
      lat: 43.8 + 0.01 * Math.sin(a),
      lon: -91.3 + 0.014 * Math.cos(a),
      distanceM: i * 8,
      speedMps: 8,
      powerW: 150 + (i % 10) * 10,
      heartRate: 120 + (i % 5),
      cadence: 85,
      altitudeM: 250 + 5 * Math.sin(a)
    }
  })
}
