/**
 * Magnetic snapping: pull a dragged timeline value to the nearest candidate
 * (clip edges, playhead, 0) when within a threshold. Pure + unit-tested.
 */

/** Snap `value` to the nearest candidate within `threshold`; else return value. */
export function snap(value: number, candidates: number[], threshold: number): number {
  let best = value
  let bestDist = threshold
  for (const c of candidates) {
    const d = Math.abs(value - c)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}
