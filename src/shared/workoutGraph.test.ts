import { describe, expect, it } from 'vitest'
import { WORKOUT_SERIES_VERSION, type WorkoutSeries } from './workout'
import {
  axisMap,
  clampView,
  clockLabel,
  graphTicks,
  linePoints,
  panView,
  valueRange,
  zoomView,
  MIN_SPAN
} from './workoutGraph'

/** 0…10 s; standing still from 4 s to 6 s (distance 40 m throughout); a GPS
 *  wobble back at 8 s. */
const s: WorkoutSeries = {
  version: WORKOUT_SERIES_VERSION,
  startUtc: '2026-05-24T13:00:00.000Z',
  t: [0, 2, 4, 6, 8, 10],
  distanceM: [0, 20, 40, 40, 70, 100],
  powerW: [100, 200, null, 300, 50, 400],
  legs: [],
  laps: [],
  pauses: []
}

describe('axisMap', () => {
  it('time: ride seconds, clamped to the recording', () => {
    const m = axisMap(s, 'time')!
    expect(m.domain).toBe(10)
    expect(m.minSpan).toBe(MIN_SPAN.time)
    expect([m.toAxis(-3), m.toAxis(5), m.toSec(12)]).toEqual([0, 5, 10])
  })

  it('distance: metres covered; a stop collapses to the moment it began', () => {
    const m = axisMap(s, 'distance')!
    expect(m.domain).toBe(100)
    expect(m.toAxis(1)).toBe(10)
    expect(m.toAxis(5)).toBe(40) // stopped
    expect(m.toSec(30)).toBe(3)
    expect(m.toSec(40)).toBe(4) // the first moment it reached 40 m, not 6 s
    expect(m.toSec(55)).toBe(7)
  })

  it('never runs backwards on a GPS wobble, and needs a distance channel', () => {
    const wobble = axisMap({ ...s, distanceM: [0, 20, 15, 30, null, 50] }, 'distance')!
    expect(wobble.at).toEqual([0, 20, 20, 30, 30, 50])
    expect(axisMap({ ...s, distanceM: undefined }, 'distance')).toBeNull()
    expect(axisMap({ ...s, distanceM: s.t.map(() => 0) }, 'distance')).toBeNull()
  })
})

describe('the view', () => {
  it('zooms about the point under the pointer, down to 1 s and no further', () => {
    const v = zoomView({ x0: 0, x1: 100 }, 25, 0.5, 100, 1)
    expect(v).toEqual({ x0: 12.5, x1: 62.5 })
    let tight = { x0: 0, x1: 100 }
    for (let i = 0; i < 40; i++) tight = zoomView(tight, 50, 0.5, 100, 1)
    expect(tight.x1 - tight.x0).toBe(1)
    expect(tight.x0).toBeCloseTo(49.5, 6)
    // Zooming out stops at the whole recording.
    expect(zoomView({ x0: 10, x1: 20 }, 15, 50, 100, 1)).toEqual({ x0: 0, x1: 100 })
  })

  it('pans within the recording', () => {
    expect(panView({ x0: 10, x1: 20 }, 5, 100, 1)).toEqual({ x0: 15, x1: 25 })
    expect(panView({ x0: 10, x1: 20 }, 500, 100, 1)).toEqual({ x0: 90, x1: 100 })
    expect(panView({ x0: 10, x1: 20 }, -500, 100, 1)).toEqual({ x0: 0, x1: 10 })
    expect(clampView({ x0: 3, x1: 3.2 }, 100, 1)).toEqual({ x0: 3, x1: 4 })
  })
})

describe('linePoints', () => {
  const m = axisMap(s, 'time')!

  it('few samples: each one in view, plus one either side, gaps left out', () => {
    const pts = linePoints(s.powerW, m, { x0: 3, x1: 7 }, 400)
    // Samples at 2, 4 (no value), 6, 8 s → x = (t − 3) × 100.
    expect(pts).toEqual([
      { x: -100, value: 200 },
      { x: 300, value: 300 },
      { x: 500, value: 50 }
    ])
  })

  it('more than two per pixel: each column keeps its lowest and highest value', () => {
    const t = Array.from({ length: 1000 }, (_, i) => i)
    const dense: WorkoutSeries = { ...s, t, distanceM: undefined, powerW: t.map((i) => (i === 503 ? 999 : i % 7)) }
    const pts = linePoints(dense.powerW, axisMap(dense, 'time')!, { x0: 0, x1: 999 }, 100)
    expect(pts.length).toBeLessThanOrEqual(202)
    // The one-sample spike survives.
    expect(pts.some((p) => p.value === 999)).toBe(true)
  })

  it('a spike on the sample just left of the view starts its own column', () => {
    // Regression: the bucket counter started at column −1, so the sample just
    // left of the view (column −1) never opened a bucket and the next read crashed.
    const t = Array.from({ length: 2000 }, (_, i) => i / 10)
    const dense: WorkoutSeries = { ...s, t, distanceM: undefined, powerW: t.map(() => 200) }
    expect(() => linePoints(dense.powerW, axisMap(dense, 'time')!, { x0: 50.05, x1: 150 }, 20)).not.toThrow()
  })

  it('a value that is not a number is left out like a gap', () => {
    const pts = linePoints([100, NaN, 300, Infinity, 50, 400], m, { x0: 0, x1: 10 }, 100)
    expect(pts.map((p) => p.value)).toEqual([100, 300, 50, 400])
  })

  it('a flat line gets room above and below', () => {
    expect(valueRange([{ x: 0, value: 200 }])).toEqual({ lo: 180, hi: 220 })
    expect(valueRange([])).toEqual({ lo: 0, hi: 1 })
  })
})

describe('ticks', () => {
  it('time: a round step about every 110 px, read as a clock', () => {
    const ticks = graphTicks({ x0: 0, x1: 3600 }, 'time', 1100, 'imperial')
    // 3600 s over 1100 px: 360 s per 110 px → a 10-minute step.
    expect(ticks.map((t) => t.label).slice(0, 3)).toEqual(['0:00', '10:00', '20:00'])
    // Zoomed to a few seconds: one per second.
    expect(graphTicks({ x0: 10, x1: 15 }, 'time', 600, 'imperial').map((t) => t.label)).toEqual([
      '0:10',
      '0:11',
      '0:12',
      '0:13',
      '0:14',
      '0:15'
    ])
    expect(clockLabel(3723)).toBe('1:02:03')
  })

  it('distance: miles or kilometres at a round step', () => {
    const mi = graphTicks({ x0: 0, x1: 16093.44 }, 'distance', 1100, 'imperial')
    expect(mi.slice(0, 3).map((t) => t.label)).toEqual(['0 mi', '1 mi', '2 mi'])
    const km = graphTicks({ x0: 0, x1: 2000 }, 'distance', 1000, 'metric')
    // 220 m wanted → a 0.25 km step, labelled to two places (not "0.3").
    expect(km.slice(0, 3).map((t) => t.label)).toEqual(['0.00 km', '0.25 km', '0.50 km'])
    const tenths = graphTicks({ x0: 0, x1: 1000 }, 'distance', 1000, 'metric')
    expect(tenths.slice(0, 2).map((t) => t.label)).toEqual(['0.0 km', '0.2 km'])
  })
})
