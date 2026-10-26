import { describe, expect, it } from 'vitest'
import type { Layer, WorkoutContent } from './project'
import type { MarkShape } from './graphics'
import { makeVideoLayer, makeWorkoutLayer } from './layers'
import { WORKOUT_SERIES_VERSION, type WorkoutSeries } from './workout'
import {
  defaultWidgets,
  distanceReading,
  formatSpeed,
  metricMissing,
  newWidget,
  slipWorkout,
  smoothHalfSec,
  speedReading,
  splitWorkout,
  syncCandidate,
  syncedWindow,
  trimWorkoutEnd,
  trimWorkoutStart,
  withWorkoutDuration,
  withWorkoutSpeed,
  workoutOverlayBounds,
  workoutOverlayShapes,
  workoutPlayedSec,
  workoutRideSec,
  workoutTimelineSec,
  canSyncTo,
  type WorkoutWidget
} from './workoutOverlay'

let n = 0
const makeId = (): string => `id${++n}`

/** A 600 s ride: power ramps 0→599 W (1 W per second), heart rate 100 + s/10,
 *  8 m/s, 8 m per second, heading due north from 0°,0°. */
const ride = (): WorkoutSeries => {
  const t = Array.from({ length: 601 }, (_, i) => i)
  return {
    version: WORKOUT_SERIES_VERSION,
    startUtc: '2026-05-24T13:00:00.000Z',
    t,
    lat: t.map((s) => s * 0.0001),
    lon: t.map(() => 0),
    distanceM: t.map((s) => s * 8),
    speedMps: t.map(() => 8),
    powerW: t.map((s) => s),
    heartRate: t.map((s) => Math.round(100 + s / 10)),
    legs: [{ startSec: 0, endSec: 600, sport: 'cycling' }],
    laps: [],
    pauses: []
  }
}

const tile = (window = { inSec: 100, outSec: 300, speed: 10 }, startSec = 5, widgets: WorkoutWidget[] = []) =>
  makeWorkoutLayer('W', 'm1', startSec, window, widgets)
const contentOf = (l: Layer): WorkoutContent => l.content as WorkoutContent

describe('timing', () => {
  it('plays the ride window at its speed: the tile lasts window ÷ speed', () => {
    const l = tile()
    const c = contentOf(l)
    expect(workoutPlayedSec(c)).toBe(20)
    expect(l.endSec).toBe(25)
    expect(workoutRideSec(c, l, 5)).toBe(100)
    expect(workoutRideSec(c, l, 7.5)).toBe(125)
    // Held at the window's ends.
    expect(workoutRideSec(c, l, 0)).toBe(100)
    expect(workoutRideSec(c, l, 99)).toBe(300)
    // And back: ride 200 s is shown at timeline 15 s.
    expect(workoutTimelineSec(c, l, 200)).toBe(15)
  })

  it('a left-edge trim moves the ride window with it, never before the recording or timeline 0', () => {
    const l = tile()
    const t = trimWorkoutStart(l, contentOf(l), 2)
    expect(t.startSec).toBe(7)
    expect(contentOf(t).inSec).toBe(120)
    expect(t.endSec).toBe(25)
    // The tile starts at 5 s: it can grow back 5 s (50 s of ride), no further.
    const back = trimWorkoutStart(l, contentOf(l), -50)
    expect([back.startSec, contentOf(back).inSec, back.endSec]).toEqual([0, 50, 25])
    // At timeline 0 with the recording's start 10 ride-seconds away.
    const early = tile({ inSec: 10, outSec: 300, speed: 10 }, 20)
    expect(contentOf(trimWorkoutStart(early, contentOf(early), -50)).inSec).toBe(0)
    expect(trimWorkoutStart(early, contentOf(early), -50).startSec).toBe(19)
  })

  it('a right-edge trim moves the window end, capped at the recording', () => {
    const l = tile()
    const t = trimWorkoutEnd(l, contentOf(l), 3, 600)
    expect(contentOf(t).outSec).toBe(330)
    expect(t.endSec).toBe(28)
    expect(contentOf(trimWorkoutEnd(l, contentOf(l), 1000, 600)).outSec).toBe(600)
    // Never shorter than the shortest tile.
    expect(trimWorkoutEnd(l, contentOf(l), -1000, 600).endSec).toBeCloseTo(5.2)
  })

  it('a split gives two tiles over consecutive ride windows at the same speed', () => {
    const w = newWidget('power', [], 'w1')
    const l = tile(undefined, 5, [w])
    const res = splitWorkout(l, contentOf(l), 10, makeId)!
    const [a, b] = res.map(contentOf)
    expect([res[0].startSec, res[0].endSec, a.inSec, a.outSec]).toEqual([5, 10, 100, 150])
    expect([res[1].startSec, res[1].endSec, b.inSec, b.outSec]).toEqual([10, 25, 150, 300])
    expect(b.speed).toBe(10)
    expect(res[1].id).not.toBe('W')
    expect(b.widgets[0].id).not.toBe('w1')
    expect(b.widgets[0]).toMatchObject({ metric: 'power', x: w.x, y: w.y })
    expect(splitWorkout(l, contentOf(l), 5, makeId)).toBeNull()
    expect(splitWorkout(l, contentOf(l), 30, makeId)).toBeNull()
  })

  it('a speed or length edit never makes a tile shorter than the shortest; edges then stay inside the recording', () => {
    // 600 s of ride at the 20000× cap would be a 0.03 s tile: capped at 3000× (0.2 s).
    const l = tile({ inSec: 0, outSec: 600, speed: 1 }, 0)
    const fast = withWorkoutSpeed(l, contentOf(l), 20000)
    expect(contentOf(fast).speed).toBe(3000)
    expect(fast.endSec).toBeCloseTo(0.2, 9)
    expect(withWorkoutDuration(l, contentOf(l), 0.01).endSec).toBeCloseTo(0.2, 9)
    // A tile ALREADY shorter (an older save): an end trim stays at the recording's end.
    const short = { ...l, endSec: 0.03, content: { ...contentOf(l), speed: 20000 } }
    expect(contentOf(trimWorkoutEnd(short, contentOf(short), -1, 600)).outSec).toBe(600)
    expect(contentOf(trimWorkoutStart(short, contentOf(short), 1)).inSec).toBe(0)
  })

  it('speed and length edits keep the window; a slip keeps length and speed', () => {
    const l = tile()
    expect(withWorkoutSpeed(l, contentOf(l), 20).endSec).toBe(15)
    const d = withWorkoutDuration(l, contentOf(l), 4)
    expect(contentOf(d).speed).toBe(50)
    expect(d.endSec).toBe(9)
    const s = slipWorkout(l, contentOf(l), 500, 600)
    expect([contentOf(s).inSec, contentOf(s).outSec, s.startSec, s.endSec]).toEqual([400, 600, 5, 25])
  })

  it('formats speeds without long decimals', () => {
    expect(formatSpeed(1)).toBe('1')
    expect(formatSpeed(2.456)).toBe('2.46')
    expect(formatSpeed(1352.7)).toBe('1353')
  })
})

describe('syncing to footage', () => {
  const t0 = Date.parse('2026-05-24T13:00:00Z')

  it('trusts the recording time of an original only, not of a clip the editor made', () => {
    // A Quick-cut piece keeps the tags of the file it was cut from.
    expect(canSyncTo({ probe: { video: {} } })).toBe(true)
    expect(canSyncTo({ generated: true, probe: { video: {} } })).toBe(false)
    expect(canSyncTo({ probe: { video: null } })).toBe(false)
  })

  it('syncs to the topmost visible video clip under the moment, if it plays at real time', () => {
    const a = makeVideoLayer('a', 'm1', 0, 10)
    const b = makeVideoLayer('b', 'm2', 2, 4)
    expect(syncCandidate([a, b], 3)?.id).toBe('b')
    expect(syncCandidate([a, b], 8)?.id).toBe('a')
    expect(syncCandidate([a, { ...b, hidden: true }], 3)?.id).toBe('a')
    expect(syncCandidate([a], 12)).toBeNull()
    // Sped up, ramped or frozen: its frames no longer map onto clock time.
    const vc = a.content as Extract<Layer['content'], { kind: 'video' }>
    expect(syncCandidate([{ ...a, content: { ...vc, speed: 2 } }], 3)).toBeNull()
    expect(syncCandidate([{ ...a, content: { ...vc, freezes: [{ atSec: 1, holdSec: 1 }] } }], 3)).toBeNull()
    expect(
      syncCandidate(
        [
          {
            ...a,
            content: {
              ...vc,
              speedRamp: [
                { atSec: 0, speed: 1 },
                { atSec: 5, speed: 2 }
              ]
            }
          }
        ],
        3
      )
    ).toBeNull()
    // Something else on top doesn't hide the clip.
    expect(syncCandidate([a, tile()], 6)?.id).toBe('a')
  })

  it('shows the recording as it was while the clip was filmed, at real time', () => {
    // The clip shows from 30 s into the workout, for 10 s, at timeline 4 s.
    expect(
      syncedWindow('2026-05-24T13:00:00.000Z', 600, { startSec: 4, endSec: 14, shownFromUtcMs: t0 + 30_000 })
    ).toEqual({
      startSec: 4,
      inSec: 30,
      outSec: 40
    })
  })

  it('trims to the part of the clip the recording covers', () => {
    // Filmed from 5 s before the watch started: the overlay starts 5 s into the clip.
    expect(
      syncedWindow('2026-05-24T13:00:00.000Z', 600, { startSec: 0, endSec: 10, shownFromUtcMs: t0 - 5000 })
    ).toEqual({
      startSec: 5,
      inSec: 0,
      outSec: 5
    })
    // Runs past the end of the recording.
    expect(
      syncedWindow('2026-05-24T13:00:00.000Z', 600, { startSec: 0, endSec: 10, shownFromUtcMs: t0 + 595_000 })
    ).toEqual({
      startSec: 0,
      inSec: 595,
      outSec: 600
    })
  })

  it('a clip filmed at another time does not sync', () => {
    expect(
      syncedWindow('2026-05-24T13:00:00.000Z', 600, { startSec: 0, endSec: 10, shownFromUtcMs: t0 + 3_600_000 })
    ).toBeNull()
    expect(syncedWindow('', 600, { startSec: 0, endSec: 10, shownFromUtcMs: t0 })).toBeNull()
  })
})

describe('metrics', () => {
  it('a metric needs its channels, and says which are missing', () => {
    expect(metricMissing('power', ['power'])).toBeNull()
    expect(metricMissing('power', ['heartRate'])).toBe('This file has no power.')
    expect(metricMissing('liveMap', [])).toBe('This file has no GPS track.')
    expect(metricMissing('speed', [])).toBe('This file has no speed.')
  })

  it('a new overlay shows power, speed, heart rate and the live map — those the file has', () => {
    const ws = defaultWidgets(['position', 'speed', 'heartRate'], makeId)
    expect(ws.map((w) => w.metric)).toEqual(['speed', 'heartRate', 'liveMap'])
    // Readouts take separate slots; the map goes up top.
    expect(new Set(ws.map((w) => `${w.x},${w.y}`)).size).toBe(3)
    expect(ws[2].y).toBeLessThan(ws[0].y)
  })

  it('speed reads as pace for a run or a swim, speed for a ride', () => {
    expect(speedReading(4, 'running', 'imperial')).toEqual({ value: '6:42', unit: '/MI' })
    expect(speedReading(4, 'running', 'metric')).toEqual({ value: '4:10', unit: '/KM' })
    expect(speedReading(1, 'swimming', 'imperial')).toEqual({ value: '1:31', unit: '/100YD' })
    expect(speedReading(10, 'cycling', 'imperial')).toEqual({ value: '22.4', unit: 'MPH' })
    expect(speedReading(10, 'cycling', 'metric')).toEqual({ value: '36.0', unit: 'KM/H' })
    // Standing still is no pace.
    expect(speedReading(0.2, 'running', 'imperial').value).toBe('--')
  })

  it('distance reads to two places under 10, one above', () => {
    expect(distanceReading(8046.72, 'imperial')).toEqual({ value: '5.00', unit: 'MI' })
    expect(distanceReading(53407.86, 'imperial', ' TOTAL')).toEqual({ value: '33.2', unit: 'MI TOTAL' })
    expect(distanceReading(null, 'metric').value).toBe('--')
  })
})

/** The label texts an overlay draws at `t`. */
const texts = (shapes: MarkShape[]): string[] => shapes.flatMap((s) => (s.kind === 'label' ? [s.text] : []))

describe('workoutOverlayShapes', () => {
  const series = ride()

  it('at real time a readout shows the raw sample at or before the moment', () => {
    const l = tile({ inSec: 100, outSec: 200, speed: 1 }, 0, [newWidget('power', [], 'p')])
    expect(texts(workoutOverlayShapes(contentOf(l), l, series, 10.7))).toEqual(['110', 'W'])
  })

  it('played fast it shows the mean around the moment, so it reads instead of flickering', () => {
    expect(smoothHalfSec(1)).toBe(0)
    expect(smoothHalfSec(100)).toBe(25)
    const l = tile({ inSec: 0, outSec: 600, speed: 100 }, 0, [newWidget('power', [], 'p')])
    // Timeline 2 s = ride 200 s; mean of 175…225 W = 200.
    expect(texts(workoutOverlayShapes(contentOf(l), l, series, 2))[0]).toBe('200')
  })

  it('totals and averages are for the whole workout, whatever the window', () => {
    const l = tile({ inSec: 0, outSec: 10, speed: 1 }, 0, [
      newWidget('totalDistance', [], 'd'),
      { ...newWidget('avgPower', [], 'a'), x: 900 }
    ])
    expect(texts(workoutOverlayShapes(contentOf(l), l, series, 5))).toEqual(['2.98', 'MI TOTAL', '300', 'AVG W'])
  })

  it('the live map draws the route and a dot where the athlete is; the static map only the route', () => {
    const map: WorkoutWidget = { ...newWidget('liveMap', [], 'm'), x: 500, y: 500, sizePx: 400 }
    const l = tile({ inSec: 0, outSec: 600, speed: 1 }, 0, [map])
    const at = (t: number): MarkShape[] => workoutOverlayShapes(contentOf(l), l, series, t)
    const dot = (t: number): string => (at(t).find((s) => s.kind === 'path' && s.fill) as { d: string }).d
    // Due north: the route is a vertical line down the box's middle (x 500);
    // the dot starts at the bottom (y 700) and is half way up at 300 s.
    expect(at(0)).toHaveLength(2)
    expect(dot(0)).toMatch(/^M\d+(\.\d+)? 700 /)
    expect(dot(300)).toMatch(/^M\d+(\.\d+)? 500 /)
    const still = tile({ inSec: 0, outSec: 600, speed: 1 }, 0, [{ ...map, metric: 'staticMap' }])
    expect(workoutOverlayShapes(contentOf(still), still, series, 300)).toHaveLength(1)
  })

  it('tracing the route draws the ridden part bold over the whole route faint', () => {
    const map: WorkoutWidget = { ...newWidget('liveMap', [], 'm'), x: 500, y: 500, sizePx: 400, trace: true }
    const l = tile({ inSec: 0, outSec: 600, speed: 1 }, 0, [map])
    const lines = workoutOverlayShapes(contentOf(l), l, series, 300).filter((s) => s.kind === 'path' && !s.fill)
    expect(lines).toHaveLength(2)
    expect((lines[0] as { stroke: string }).stroke).toBe('#FFFFFF55')
    // The ridden part ends exactly where the dot is.
    expect((lines[1] as { d: string }).d).toMatch(/L500 500$/)
  })

  it('distance so far is the distance at the moment, between samples too', () => {
    const l = tile({ inSec: 0, outSec: 600, speed: 1 }, 0, [newWidget('distance', [], 'd')])
    // 8 m per second: 100.5 s = 804 m = 0.50 mi.
    expect(texts(workoutOverlayShapes(contentOf(l), l, series, 100.5))).toEqual(['0.50', 'MI'])
  })

  it('speed follows the leg of a multisport file: pace on the run, speed on the bike', () => {
    const tri: WorkoutSeries = {
      ...ride(),
      speedMps: ride().t.map((s) => (s < 300 ? 10 : 4)),
      legs: [
        { startSec: 0, endSec: 300, sport: 'cycling' },
        { startSec: 300, endSec: 600, sport: 'running' }
      ]
    }
    const l = tile({ inSec: 0, outSec: 600, speed: 1 }, 0, [newWidget('speed', [], 's')])
    expect(texts(workoutOverlayShapes(contentOf(l), l, tri, 100))).toEqual(['22.4', 'MPH'])
    expect(texts(workoutOverlayShapes(contentOf(l), l, tri, 400))).toEqual(['6:42', '/MI'])
  })

  it('a widget whose data the file lacks draws nothing', () => {
    const noPower = { ...ride(), powerW: undefined }
    const l = tile({ inSec: 0, outSec: 10, speed: 1 }, 0, [
      newWidget('power', [], 'p'),
      newWidget('heartRate', [], 'h')
    ])
    expect(texts(workoutOverlayShapes(contentOf(l), l, noPower, 1))).toEqual(['100', 'BPM'])
  })

  it('bounds every widget for the export to crop to', () => {
    expect(workoutOverlayBounds({ widgets: [] })).toBeNull()
    const b = workoutOverlayBounds({
      widgets: [
        { ...newWidget('power', [], 'p'), x: 200, y: 1400, sizePx: 100 },
        { ...newWidget('liveMap', [], 'm'), x: 800, y: 400, sizePx: 400 }
      ]
    })!
    // The readout's box is 3.8× its size wide; the map's has a 6% margin for its dot.
    expect(b.x).toBe(10)
    expect(b.x + b.w).toBe(1024)
    expect(b.y).toBe(176)
    expect(b.y + b.h).toBe(1500)
  })
})
