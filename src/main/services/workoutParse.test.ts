import { describe, expect, it } from 'vitest'
import { decodeWorkout, seriesFromMessages, workoutProbe, type FitRecord } from './workoutParse'
import { buildFitFile, loopRide } from './__fixtures__/fitFile'

const T0 = Date.parse('2026-05-24T13:00:00Z')
const at = (sec: number): Date => new Date(T0 + sec * 1000)
const SEMI = 2 ** 31 / 180

describe('seriesFromMessages', () => {
  it('aligns every channel with seconds from the first sample, sorted', () => {
    const s = seriesFromMessages({
      recordMesgs: [
        { timestamp: at(2), power: 200, heartRate: 130 },
        { timestamp: at(0), power: 100, heartRate: 120 },
        { timestamp: at(1), heartRate: 125 }
      ]
    })
    expect(s.t).toEqual([0, 1, 2])
    expect(s.powerW).toEqual([100, null, 200])
    expect(s.heartRate).toEqual([120, 125, 130])
    expect(s.startUtc).toBe('2026-05-24T13:00:00.000Z')
  })

  it('spreads samples that share a second across it instead of dropping them', () => {
    // TrainingPeaks Virtual writes several samples per second, distance still advancing.
    const s = seriesFromMessages({
      recordMesgs: [
        { timestamp: at(0), distance: 1 },
        { timestamp: at(1), distance: 2 },
        { timestamp: at(1), distance: 3 },
        { timestamp: at(1), distance: 4 },
        { timestamp: at(2), distance: 5 }
      ]
    })
    expect(s.t).toEqual([0, 1, 1.333, 1.667, 2])
    expect(s.distanceM).toEqual([1, 2, 3, 4, 5])
  })

  it('converts semicircles to degrees and drops half or impossible positions', () => {
    const s = seriesFromMessages({
      recordMesgs: [
        { timestamp: at(0), positionLat: 43.8 * SEMI, positionLong: -91.3 * SEMI },
        { timestamp: at(1), positionLat: 43.81 * SEMI },
        { timestamp: at(2), positionLat: 43.82 * SEMI, positionLong: -91.31 * SEMI }
      ]
    })
    expect(s.lat).toEqual([43.8, null, 43.82])
    expect(s.lon).toEqual([-91.3, null, -91.31])
  })

  it('leaves out a channel the file does not really carry', () => {
    // An indoor trainer ride: distance 0 throughout, no strap (heart rate 0), no GPS.
    const recs: FitRecord[] = [0, 1, 2].map((i) => ({ timestamp: at(i), distance: 0, heartRate: 0, power: 180 }))
    const s = seriesFromMessages({ recordMesgs: recs })
    expect(s.distanceM).toBeUndefined()
    expect(s.heartRate).toBeUndefined()
    expect(s.lat).toBeUndefined()
    expect(s.powerW).toEqual([180, 180, 180])
    expect('distanceM' in s).toBe(false)
  })

  it('prefers the enhanced speed and altitude fields', () => {
    const s = seriesFromMessages({
      recordMesgs: [{ timestamp: at(0), speed: 1, enhancedSpeed: 9.5, altitude: 10, enhancedAltitude: 1200.4 }]
    })
    expect(s.speedMps).toEqual([9.5])
    expect(s.altitudeM).toEqual([1200.4])
  })

  it('keeps legs, laps and timer pauses in seconds from the first sample', () => {
    const s = seriesFromMessages({
      recordMesgs: [0, 100, 200, 300].map((i) => ({ timestamp: at(i), power: 100 })),
      sessionMesgs: [
        { startTime: at(120), totalElapsedTime: 180, sport: 'running' },
        { startTime: at(0), totalElapsedTime: 120, sport: 'cycling' }
      ],
      lapMesgs: [
        { startTime: at(0), totalElapsedTime: 0 },
        { startTime: at(0), totalElapsedTime: 150 }
      ],
      eventMesgs: [
        { timestamp: at(0), event: 'timer', eventType: 'start' },
        { timestamp: at(50), event: 'timer', eventType: 'stop' },
        { timestamp: at(80), event: 'timer', eventType: 'start' },
        { timestamp: at(90), event: 'timer', eventType: 'stop' },
        { timestamp: at(90), event: 'timer', eventType: 'start' },
        { timestamp: at(95), event: 'cadLowAlert', eventType: 'start' },
        { timestamp: at(300), event: 'timer', eventType: 'stopAll' }
      ]
    })
    expect(s.legs).toEqual([
      { startSec: 0, endSec: 120, sport: 'cycling' },
      { startSec: 120, endSec: 300, sport: 'running' }
    ])
    // The zero-length lap goes; the stop/start in one second is no pause; the
    // final stopAll has no restart inside the recording.
    expect(s.laps).toEqual([{ startSec: 0, endSec: 150 }])
    expect(s.pauses).toEqual([{ startSec: 50, endSec: 80 }])
  })

  it('a leg or lap starting before the first sample still ends where its length says', () => {
    // TrainingPeaks Virtual: the session starts 2 minutes before the first sample.
    const s = seriesFromMessages({
      recordMesgs: [0, 100, 500].map((i) => ({ timestamp: at(i), power: 100 })),
      lapMesgs: [
        { startTime: at(-120), totalElapsedTime: 300 },
        { startTime: at(180), totalElapsedTime: 320 }
      ]
    })
    expect(s.laps).toEqual([
      { startSec: 0, endSec: 180 },
      { startSec: 180, endSec: 500 }
    ])
  })

  it('refuses a course: its samples are a planned route', () => {
    expect(() =>
      seriesFromMessages({ fileIdMesgs: [{ type: 'course' }], recordMesgs: [{ timestamp: at(0), distance: 1 }] })
    ).toThrow(/course/)
  })

  it('refuses a planned workout and a file with no samples, in words', () => {
    expect(() => seriesFromMessages({ fileIdMesgs: [{ type: 'workout' }] })).toThrow(/planned workout/)
    expect(() => seriesFromMessages({ fileIdMesgs: [{ type: 'settings' }] })).toThrow(/no recorded samples/)
  })
})

describe('decodeWorkout (real FIT bytes from the SDK encoder)', () => {
  it('reads a ride back with every channel', () => {
    const s = decodeWorkout(buildFitFile({ samples: loopRide(60), pauses: [[20, 30]] }))
    expect(s.t).toHaveLength(60)
    expect(s.t[59]).toBe(59)
    expect(s.lat?.[0]).toBeCloseTo(43.8, 5)
    expect(s.lon?.[0]).toBeCloseTo(-91.286, 5)
    expect(s.distanceM?.[10]).toBeCloseTo(80, 1)
    expect(s.speedMps?.[10]).toBeCloseTo(8, 2)
    expect(s.powerW?.[3]).toBe(180)
    expect(s.heartRate?.[3]).toBe(123)
    expect(s.cadence?.[0]).toBe(85)
    expect(s.altitudeM?.[0]).toBeCloseTo(250, 0)
    expect(s.legs).toEqual([{ startSec: 0, endSec: 59, sport: 'cycling' }])
    expect(s.pauses).toEqual([{ startSec: 20, endSec: 30 }])
  })

  it('probes as a workout: no streams, the recorded span, a summary', () => {
    const probe = workoutProbe(decodeWorkout(buildFitFile({ samples: loopRide(61), sport: 'running' })))
    expect(probe).toMatchObject({ durationSec: 60, container: 'fit', video: null, audio: null })
    expect(probe.workout).toMatchObject({
      sport: 'running',
      startUtc: '2026-05-24T13:00:00.000Z',
      channels: ['position', 'distance', 'speed', 'power', 'heartRate', 'cadence', 'altitude'],
      distanceM: 480
    })
    // Six whole 150…240 W cycles (mean 195) plus one more 150 W sample.
    expect(probe.workout?.avgPowerW).toBeCloseTo((60 * 195 + 150) / 61, 6)
  })

  it('a file cut short (a flat battery mid-ride) still gives the samples before the damage', () => {
    const whole = buildFitFile({ samples: loopRide(60) })
    const s = decodeWorkout(whole.slice(0, Math.floor(whole.length * 0.6)))
    expect(s.t.length).toBeGreaterThan(10)
    expect(s.t.length).toBeLessThan(60)
    expect(s.powerW?.[0]).toBe(150)
  })

  it('refuses a planned-workout file and bytes that are not FIT', () => {
    expect(() => decodeWorkout(buildFitFile({ type: 'workout', samples: [] }))).toThrow(/planned workout/)
    expect(() => decodeWorkout(new TextEncoder().encode('not a fit file at all'))).toThrow(/isn't a FIT file/)
  })
})
