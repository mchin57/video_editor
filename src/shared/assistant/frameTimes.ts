/** Which source times `get_frames` grabs. Pure. */

export const MAX_FRAMES = 8
/** Stay this far inside the end: a seek to the very last instant can return no frame. */
const END_GUARD_SEC = 0.05

/**
 * Explicit `times` (clamped into the clip, duplicates dropped), else `count`
 * evenly spaced frames at the centres of equal slices (default 4). Never more
 * than MAX_FRAMES.
 */
export function frameTimes(durationSec: number, times?: number[], count?: number): number[] {
  const last = Math.max(0, durationSec - END_GUARD_SEC)
  if (times?.length) {
    return [...new Set(times.map((t) => Math.min(Math.max(0, t), last)))].slice(0, MAX_FRAMES)
  }
  const n = Math.min(Math.max(1, count ?? 4), MAX_FRAMES)
  return Array.from({ length: n }, (_, i) => Math.min(((i + 0.5) * durationSec) / n, last))
}
