import { describe, expect, it } from 'vitest'
import {
  formatDistance,
  routeShape,
  seriesChannels,
  sportLabel,
  summarizeWorkout,
  workoutSport,
  workoutThumbSvg,
  WORKOUT_SERIES_VERSION,
  type WorkoutSeries
} from './workout'

const series = (over: Partial<WorkoutSeries> = {}): WorkoutSeries => ({
  version: WORKOUT_SERIES_VERSION,
  startUtc: '2026-05-24T13:00:00.000Z',
  t: [0, 1, 2],
  legs: [],
  laps: [],
  pauses: [],
  ...over
})

describe('summary', () => {
  it('names the channels present, in a fixed order', () => {
    const s = series({ powerW: [1, 2, 3], lat: [1, 2, 3], lon: [1, 2, 3], heartRate: [1, 2, 3] })
    expect(seriesChannels(s)).toEqual(['position', 'power', 'heartRate'])
  })

  it('one discipline is its sport; several are multisport; transitions do not count', () => {
    const leg = (sport: string) => ({ startSec: 0, endSec: 1, sport })
    expect(workoutSport([leg('cycling')])).toBe('cycling')
    expect(workoutSport([leg('swimming'), leg('transition'), leg('cycling'), leg('running')])).toBe('multisport')
    expect(workoutSport([leg('running'), leg('transition')])).toBe('running')
    expect(workoutSport([])).toBe('workout')
  })

  it('total distance is the furthest reached; average power is the mean of the samples', () => {
    const s = summarizeWorkout(series({ distanceM: [0, null, 5000], powerW: [100, null, 200] }))
    expect(s.distanceM).toBe(5000)
    expect(s.avgPowerW).toBe(150)
    expect(summarizeWorkout(series()).distanceM).toBeNull()
    expect(summarizeWorkout(series()).avgPowerW).toBeNull()
  })
})

describe('routeShape', () => {
  // A square-ish track at the equator: 0.01° each way.
  const square = series({
    t: [0, 1, 2, 3, 4],
    lat: [0, 0, 0.01, 0.01, 0],
    lon: [0, 0.01, 0.01, 0, 0]
  })

  it('fits the track in the box, centred, north up, aspect kept', () => {
    const pts = routeShape(square, 100, 200, 10)
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    // Square route in a tall box: 80 px wide, centred vertically.
    expect(Math.min(...xs)).toBeCloseTo(10)
    expect(Math.max(...xs)).toBeCloseTo(90)
    expect(Math.min(...ys)).toBeCloseTo(60)
    expect(Math.max(...ys)).toBeCloseTo(140)
    // North (higher latitude) is up: the third point is above the first.
    expect(pts[2].y).toBeLessThan(pts[0].y)
    // East is right.
    expect(pts[1].x).toBeGreaterThan(pts[0].x)
  })

  it('narrows longitude by the latitude so a route keeps its real shape', () => {
    // 0.01° of longitude at 60° N is half as far as 0.01° of latitude.
    const north = series({ t: [0, 1, 2], lat: [60, 60, 60.01], lon: [0, 0.01, 0.01] })
    const pts = routeShape(north, 1000, 1000)
    const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
    const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
    expect(w / h).toBeCloseTo(0.5, 2)
  })

  it('a straight north-south track fills the height; a track that never moved is one centred spot', () => {
    const line = routeShape(series({ lat: [0, 0.5, 1], lon: [5, 5, 5] }), 100, 100)
    expect(line.map((p) => p.y)).toEqual([100, 50, 0])
    expect(line.every((p) => p.x === 50)).toBe(true)
    const still = routeShape(series({ lat: [1, 1, 1], lon: [2, 2, 2] }), 100, 60)
    expect(still.every((p) => p.x === 50 && p.y === 30)).toBe(true)
  })

  it('skips samples without a position and caps the points, keeping the last', () => {
    expect(routeShape(series({ lat: [null, 1, null], lon: [null, 1, null] }), 10, 10)).toEqual([])
    expect(routeShape(series(), 10, 10)).toEqual([])
    const n = 1001
    const long = series({
      t: Array.from({ length: n }, (_, i) => i),
      lat: Array.from({ length: n }, (_, i) => i / 1000),
      lon: Array.from({ length: n }, () => 0)
    })
    const pts = routeShape(long, 100, 100, 0, 100)
    expect(pts.length).toBeLessThanOrEqual(101)
    expect(pts[pts.length - 1].y).toBeCloseTo(0)
  })
})

describe('workoutThumbSvg', () => {
  it('draws the route with a start dot when there is GPS', () => {
    const svg = workoutThumbSvg(series({ lat: [0, 0.01, 0.02], lon: [0, 0.01, 0] }))
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('<polyline')
    expect(svg).toContain('<circle')
  })

  it('falls back to a sparkline without GPS, and to the word FIT with nothing to draw', () => {
    const indoor = workoutThumbSvg(series({ powerW: [100, 250, 180] }))
    expect(indoor).toContain('<polyline')
    expect(indoor).not.toContain('<circle')
    expect(workoutThumbSvg(series())).toContain('>FIT</text>')
  })
})

describe('words', () => {
  it('formats distance in miles or kilometres', () => {
    expect(formatDistance(53407.86)).toBe('33.2 mi')
    expect(formatDistance(53407.86, 'metric')).toBe('53.4 km')
    expect(formatDistance(180000, 'metric')).toBe('180 km')
  })

  it('names sports the way an athlete would', () => {
    expect(sportLabel('cycling')).toBe('Ride')
    expect(sportLabel('multisport')).toBe('Multisport')
    expect(sportLabel('rowing')).toBe('Rowing')
    expect(sportLabel('fitnessEquipment')).toBe('Fitness equipment')
  })
})
