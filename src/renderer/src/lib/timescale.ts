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

/** Most ticks `scaleTicks` returns, whatever the span. Every tick is a DOM node,
 *  and an absurd End (300000 s, 1e9 s) once froze or crashed the timeline. */
export const MAX_SCALE_TICKS = 2000

/** Tick times from 0 up to and including `total` at `step` spacing. A span
 *  that would need more than `MAX_SCALE_TICKS` ticks keeps every n-th one (still
 *  multiples of `step`, still spanning 0…`total`). */
export function scaleTicks(total: number, step: number): number[] {
  if (!(step > 0) || !(total >= 0)) return [0]
  const span = Math.min(total, Number.MAX_SAFE_INTEGER)
  const stride = Math.max(1, Math.ceil((span + 1e-6) / step / (MAX_SCALE_TICKS - 1)))
  const every = step * stride
  const count = Math.floor((span + 1e-6) / every)
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) ticks.push(Math.round(i * every * 1000) / 1000)
  return ticks
}

/** m:ss, or m:ss.t when the step is sub-second (high zoom). */
export function formatTick(sec: number, step: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`
}
