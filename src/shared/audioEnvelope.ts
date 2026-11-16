/**
 * An audio clip's GAIN ENVELOPE: its fades and its volume line (the "rubber
 * band" on its tile, `AudioClip.volumeKeyframes`).
 *
 * THE PARITY POINT for how a clip's level moves over time. The preview's
 * `AudioFollower` multiplies the clip's normal gain (`clipGain`, volume levels
 * included) by `envelopeGainAt` on every clock tick; the export bakes the SAME
 * line into a `volume` expression (`volumeLineExpr`, `ffmpegFilters.ts`) from
 * `clipLinePoints`, and keeps `afade` for the fades — `fadeGainAt` is the
 * preview twin of `afade`'s default (linear, `tri`) curve. Verified against the
 * real binary: docs/FFMPEG-NOTES.md "Volume line".
 *
 * The rules:
 *  - Points are anchored to the audio in SOURCE seconds, each a dB offset on top
 *    of the clip's normal gain, from `VOLUME_LINE_SILENCE_DB` up to
 *    `VOLUME_LINE_MAX_DB`. No points = a flat line at 0 dB.
 *  - Straight lines IN dB between points; before the first point and after the
 *    last the line holds that point's value.
 *  - Silence: a hold at `VOLUME_LINE_SILENCE_DB`, or a stretch whose two ends
 *    are both there, is true silence (gain 0). A stretch rising out of silence
 *    starts at −60 dB, so the level is continuous apart from that inaudible step.
 *  - A segment covers [a, b): at a point's own time the segment AFTER it applies
 *    (the export expression's `lt()` nesting, mirrored exactly).
 * Pure; unit-tested (`audioEnvelope.test.ts`).
 */

import type { AudioClip, VolumeKeyframe } from './project'
import { audioHeldAt, audioHoldSpans, audioPlayedSec, audioTimelineAt } from './audioTiming'
import { clamp } from './math'

/** The top of the volume line (dB over the clip's normal gain). */
export const VOLUME_LINE_MAX_DB = 12
/** The bottom of the volume line: silence. */
export const VOLUME_LINE_SILENCE_DB = -60
/** Closest two points may sit (source seconds) — a drag stops this far short
 *  of a neighbour, and a click this close to a point doesn't add another. */
export const MIN_POINT_GAP_SEC = 0.01

/** A line point on any time axis (`t`: source or timeline seconds). */
export interface LinePoint {
  t: number
  db: number
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000
const round1 = (n: number): number => Math.round(n * 10) / 10

/** A point's dB limited to the line's range (silence … +12) and to 0.1 dB. */
export function clampLineDb(db: number): number {
  return round1(clamp(db, VOLUME_LINE_SILENCE_DB, VOLUME_LINE_MAX_DB))
}

/** Whether `db` sits at the bottom of the line (silence). */
export function isSilenceDb(db: number): boolean {
  return db <= VOLUME_LINE_SILENCE_DB + 1e-9
}

/** Linear gain of a HELD value: silence is 0, anything else 10^(dB/20). */
function holdGain(db: number): number {
  return isSilenceDb(db) ? 0 : Math.pow(10, db / 20)
}

/** Whether the clip has a volume line (at least one point). */
export function hasVolumeLine(clip: Pick<AudioClip, 'volumeKeyframes'>): boolean {
  return (clip.volumeKeyframes?.length ?? 0) > 0
}

/** The clip's points sorted by source time (a copy; empty for a flat line). */
export function sortedVolumeKeyframes(clip: Pick<AudioClip, 'volumeKeyframes'>): VolumeKeyframe[] {
  return [...(clip.volumeKeyframes ?? [])].sort((a, b) => a.sourceSec - b.sourceSec)
}

/** `clip` with its line set to `points` (sorted); an empty list removes the field. */
export function withVolumeKeyframes(clip: AudioClip, points: VolumeKeyframe[]): AudioClip {
  if (points.length === 0) {
    if (!('volumeKeyframes' in clip)) return clip
    const { volumeKeyframes, ...rest } = clip
    return rest
  }
  return { ...clip, volumeKeyframes: [...points].sort((a, b) => a.sourceSec - b.sourceSec) }
}

/** The index of the segment holding `x` (points sorted): -1 before the first
 *  point, `n-1` at or after the last, else i with p[i].t ≤ x < p[i+1].t. */
function segmentAt(p: readonly LinePoint[], x: number): number {
  if (x < p[0].t) return -1
  for (let i = 0; i < p.length - 1; i++) if (x < p[i + 1].t) return i
  return p.length - 1
}

/** The line's value in dB at `x` (points sorted by `t`; 0 for no points). */
export function lineDbAt(points: readonly LinePoint[], x: number): number {
  if (points.length === 0) return 0
  const i = segmentAt(points, x)
  if (i < 0) return points[0].db
  if (i >= points.length - 1) return points[points.length - 1].db
  const a = points[i]
  const b = points[i + 1]
  const span = b.t - a.t
  return span > 0 ? a.db + ((b.db - a.db) * (x - a.t)) / span : b.db
}

/** The line's LINEAR gain at `x` (points sorted by `t`; 1 for no points), with
 *  the silence rule from the module header. */
export function lineGainAt(points: readonly LinePoint[], x: number): number {
  if (points.length === 0) return 1
  const i = segmentAt(points, x)
  if (i < 0) return holdGain(points[0].db)
  if (i >= points.length - 1) return holdGain(points[points.length - 1].db)
  const a = points[i]
  const b = points[i + 1]
  if (isSilenceDb(a.db) && isSilenceDb(b.db)) return 0
  return Math.pow(10, lineDbAt(points, x) / 20)
}

/**
 * The clip's line in TIMELINE seconds — each point mapped through the clip's
 * timing (`audioTimelineAt`: its speed and holds; a straight offset at 1× with
 * none) — trimmed to what the window `inSec..outSec` can hear: the points
 * inside it plus the nearest one beyond each edge, which still shape the slope
 * at the edge. `outSec` is the clip's effective source out-point. The values
 * inside the window are exactly the full line's.
 *
 * A HOLD pauses the source, so the line pauses with it: a hold between two
 * points gets a point at each of its ends carrying the line's value at the
 * held source second. Without them the slope would be spread across the
 * (silent) hold and the level after it would arrive early.
 */
export function clipLinePoints(
  clip: Pick<AudioClip, 'startSec' | 'inSec' | 'volumeKeyframes' | 'speed' | 'freezes'>,
  outSec: number
): LinePoint[] {
  const src = sortedVolumeKeyframes(clip)
  if (src.length === 0) return []
  let first = src.findIndex((k) => k.sourceSec >= clip.inSec)
  if (first < 0) first = src.length - 1
  else if (first > 0) first -= 1
  let last = src.length - 1
  for (let i = 0; i < src.length; i++) {
    if (src[i].sourceSec > outSec) {
      last = i
      break
    }
  }
  const kept = src.slice(first, last + 1)
  const points = kept.map((k) => ({ t: audioTimelineAt(clip, k.sourceSec), db: k.db }))
  const lo = kept[0].sourceSec
  const hi = kept[kept.length - 1].sourceSec
  // A hold exactly ON the first point pauses the line too (the slope after it
  // must start where the hold ends); past the last point the line is flat.
  const holds = audioHoldSpans(clip, outSec).filter((h) => h.holdSec > 0 && h.atSec >= lo && h.atSec < hi)
  if (holds.length === 0) return points
  const srcLine = kept.map((k) => ({ t: k.sourceSec, db: k.db }))
  for (const h of holds) {
    const db = lineDbAt(srcLine, h.atSec)
    points.push({ t: h.startSec, db }, { t: h.endSec, db })
  }
  // Stable: a point sitting exactly on a hold keeps its place before the pair;
  // an exact duplicate (a point on a hold's start) is dropped.
  return points
    .sort((a, b) => a.t - b.t)
    .filter((p, i, all) => i === 0 || p.t !== all[i - 1].t || p.db !== all[i - 1].db)
}

/**
 * The fades' linear gain at timeline second `t` — the preview twin of the
 * export's `afade` (default `tri` curve: linear in amplitude). The fade-in runs
 * from the clip's start, the fade-out ends at its end (`durSec` = its played
 * length); when they overlap, the two multiply, as two chained `afade`s do.
 */
export function fadeGainAt(
  clip: Pick<AudioClip, 'startSec' | 'fadeInSec' | 'fadeOutSec'>,
  durSec: number,
  t: number
): number {
  let g = 1
  if (clip.fadeInSec > 0) g *= clamp((t - clip.startSec) / clip.fadeInSec, 0, 1)
  if (clip.fadeOutSec > 0) {
    const st = Math.max(0, clip.startSec + durSec - clip.fadeOutSec)
    g *= clamp(1 - (t - st) / clip.fadeOutSec, 0, 1)
  }
  return g
}

/**
 * THE envelope: the linear factor the clip's normal gain is multiplied by at
 * timeline second `t` — fades × volume line. `outSec` is the clip's effective
 * source out-point (`effectiveOut`).
 */
export function envelopeGainAt(clip: AudioClip, outSec: number, t: number): number {
  // A hold (freeze) is silence — the export pads it with zeros.
  if (clip.freezes?.length && audioHeldAt(clip, outSec, t)) return 0
  const fades = fadeGainAt(clip, audioPlayedSec(clip, outSec), t)
  if (fades === 0 || !hasVolumeLine(clip)) return fades
  return fades * lineGainAt(clipLinePoints(clip, outSec), t)
}

/** The line's value (dB) at SOURCE second `sourceSec` of `points`. */
export function volumeLineDbAt(points: readonly VolumeKeyframe[], sourceSec: number): number {
  return lineDbAt(
    [...points].sort((a, b) => a.sourceSec - b.sourceSec).map((k) => ({ t: k.sourceSec, db: k.db })),
    sourceSec
  )
}

// --- Editing (pure; the store wraps each in one undo step) ---

/**
 * Add a point at `sourceSec` with `db` (clamped, rounded to 1 ms / 0.1 dB).
 * A point already within `MIN_POINT_GAP_SEC` is moved to the new level instead
 * of a second one being stacked on it. Returns the sorted list and the index
 * of the point that was added (or re-levelled).
 */
export function addVolumeKeyframe(
  points: readonly VolumeKeyframe[],
  kf: VolumeKeyframe
): { points: VolumeKeyframe[]; index: number } {
  const at = round3(kf.sourceSec)
  const db = clampLineDb(kf.db)
  const sorted = [...points].sort((a, b) => a.sourceSec - b.sourceSec)
  const near = sorted.findIndex((k) => Math.abs(k.sourceSec - at) < MIN_POINT_GAP_SEC)
  if (near >= 0) {
    sorted[near] = { ...sorted[near], db }
    return { points: sorted, index: near }
  }
  const next = [...sorted, { sourceSec: at, db }].sort((a, b) => a.sourceSec - b.sourceSec)
  return { points: next, index: next.findIndex((k) => k.sourceSec === at) }
}

/**
 * Move point `index` (of the SORTED list) to `to`: its time stays strictly
 * between its neighbours (`MIN_POINT_GAP_SEC` short of each) and inside
 * `bounds` when given (the clip's window); its level is clamped to the line's
 * range. Never reorders the list.
 */
export function moveVolumeKeyframe(
  points: readonly VolumeKeyframe[],
  index: number,
  to: VolumeKeyframe,
  bounds?: { min: number; max: number }
): VolumeKeyframe[] {
  const sorted = [...points].sort((a, b) => a.sourceSec - b.sourceSec)
  if (index < 0 || index >= sorted.length) return sorted
  let lo = index > 0 ? sorted[index - 1].sourceSec + MIN_POINT_GAP_SEC : -Infinity
  let hi = index < sorted.length - 1 ? sorted[index + 1].sourceSec - MIN_POINT_GAP_SEC : Infinity
  if (bounds) {
    lo = Math.max(lo, bounds.min)
    hi = Math.min(hi, bounds.max)
  }
  // A point squeezed between neighbours closer than two gaps stays where it is.
  const at = lo > hi ? sorted[index].sourceSec : round3(clamp(to.sourceSec, lo, hi))
  sorted[index] = { sourceSec: at, db: clampLineDb(to.db) }
  return sorted
}

/** Remove point `index` (of the SORTED list). */
export function removeVolumeKeyframe(points: readonly VolumeKeyframe[], index: number): VolumeKeyframe[] {
  const sorted = [...points].sort((a, b) => a.sourceSec - b.sourceSec)
  if (index < 0 || index >= sorted.length) return sorted
  return sorted.filter((_, i) => i !== index)
}

/**
 * The line for BOTH halves of a split at source second `cutSec`: every point
 * kept (a trim back out restores the rest), plus one pinned at the cut with the
 * line's value there, so each half's level up to the seam no longer depends on
 * the other half's points — editing one can't move the level at the seam of
 * the other. A flat line stays flat (no points added); a point already at the
 * cut is the pin.
 */
export function splitVolumeKeyframes(points: readonly VolumeKeyframe[], cutSec: number): VolumeKeyframe[] {
  if (points.length === 0) return []
  const sorted = [...points].sort((a, b) => a.sourceSec - b.sourceSec)
  if (sorted.some((k) => Math.abs(k.sourceSec - cutSec) < 1e-6)) return sorted
  const db = round3(volumeLineDbAt(sorted, cutSec))
  return [...sorted, { sourceSec: cutSec, db }].sort((a, b) => a.sourceSec - b.sourceSec)
}
