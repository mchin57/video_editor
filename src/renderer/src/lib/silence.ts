/**
 * Turn detected silent intervals into the speech segments of a clip, for
 * "split on silence". Segments keep their source timing (we split, we don't
 * compress gaps), so the result stays in sync with the rest of the timeline.
 * Pure + unit-tested.
 */

export interface Interval {
  start: number
  end: number
}

export function speechSegments(
  silences: Interval[],
  inSec: number,
  outSec: number,
  minSpeechSec = 0.3
): Interval[] {
  const sil = silences
    .map((s) => ({ start: Math.max(s.start, inSec), end: Math.min(s.end, outSec) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)

  const speech: Interval[] = []
  let cursor = inSec
  for (const s of sil) {
    if (s.start > cursor) speech.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < outSec) speech.push({ start: cursor, end: outSec })
  return speech.filter((s) => s.end - s.start >= minSpeechSec)
}
