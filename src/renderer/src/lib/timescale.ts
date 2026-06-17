/**
 * Pick a "nice" tick interval for the timeline's time scale so labels stay
 * readable at any zoom, and format tick labels. Pure + unit-tested.
 */

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600] // seconds

/** Smallest nice step whose on-screen width is at least `minPx`. */
export function niceTimeStep(pxPerSec: number, minPx = 64): number {
  for (const s of STEPS) {
    if (s * pxPerSec >= minPx) return s
  }
  return STEPS[STEPS.length - 1]
}

/** Tick times from 0 up to and including `total` at `step` spacing. */
export function scaleTicks(total: number, step: number): number[] {
  if (step <= 0) return [0]
  const ticks: number[] = []
  for (let t = 0; t <= total + 1e-6; t += step) ticks.push(Math.round(t * 1000) / 1000)
  return ticks
}

/** m:ss, or m:ss.t when the step is sub-second (high zoom). */
export function formatTick(sec: number, step: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`
}
