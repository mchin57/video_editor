/** Which source times `get_frames` grabs. Pure. */

export const MAX_FRAMES = 8
/** Stay this far inside the end: a seek to the very last instant can return no frame. */
const END_GUARD_SEC = 0.05

/**
 * Explicit `times` (clamped into the clip, duplicates dropped), else `count`
 * evenly spaced frames at the centres of equal slices (default 4). Never more
 * than MAX_FRAMES. A still (`durationSec` 0 or less — the caller passes 0 for an
 * image, whose probed length is 0 or a nominal 0.04 s) has one picture, so it
 * gets one frame, never `count` copies of it.
 */
export function frameTimes(durationSec: number, times?: number[], count?: number): number[] {
  if (!(durationSec > 0)) return [0]
  const last = Math.max(0, durationSec - END_GUARD_SEC)
  if (times?.length) {
    return [...new Set(times.map((t) => Math.min(Math.max(0, t), last)))].slice(0, MAX_FRAMES)
  }
  const n = Math.min(Math.max(1, count ?? 4), MAX_FRAMES)
  // A clip shorter than the end guard clamps every slice to one time: keep it once.
  return [...new Set(Array.from({ length: n }, (_, i) => Math.min(((i + 0.5) * durationSec) / n, last)))]
}
