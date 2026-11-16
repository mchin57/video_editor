/**
 * AUDIO CLIP TIMING: where an audio clip's source plays on the timeline, and
 * back. An audio clip is re-timed exactly like a video layer — a constant
 * `speed` (pitch kept) and source-anchored `freezes`, which for audio are
 * stretches of SILENCE — so every conversion here is the shared `Retimed`
 * mapping (`shared/speed.ts`) applied to the clip's window (`audioTiming`,
 * `shared/project.ts`). Nothing in the app converts an audio clip's timeline
 * time to source time (or back) any other way: tile ends, trims, splits, the
 * preview follower, the export, captions, the volume line. At 1× with no holds
 * every function is the old straight offset (`audioTiming.test.ts` pins it).
 *
 * `outSec` parameters are the clip's RESOLVED source out-point
 * (`effectiveOut(clip, sourceDuration)`). Pure. @see docs/SHARED.md
 */

import type { AudioClip, FreezeHold } from './project'
import { audioTiming } from './project'
import {
  heldAtPlayed,
  holdSpans,
  playedAtSource,
  playedBetween,
  playedDuration,
  sourceAtPlayed,
  videoSpeed
} from './speed'

type Timed = Pick<AudioClip, 'startSec' | 'inSec' | 'speed' | 'freezes'>

/** The clip's constant speed (1 when unset; the video range and clamp). */
export const audioSpeed = (clip: Pick<AudioClip, 'speed'>): number => videoSpeed(clip)

/** Whether the clip is re-timed at all (a speed other than 1, or a hold). */
export function audioRetimed(clip: Pick<AudioClip, 'speed' | 'freezes'>): boolean {
  return audioSpeed(clip) !== 1 || (clip.freezes?.length ?? 0) > 0
}

/** The clip's PLAYED (timeline) length: its source window at its speed, plus
 *  its holds. */
export function audioPlayedSec(clip: Timed, outSec: number): number {
  return playedDuration(audioTiming(clip, outSec))
}

/** The SOURCE second the clip plays at timeline second `t` (clamped to its
 *  window; inside a hold, the held source point). */
export function audioSourceAt(clip: Timed, outSec: number, t: number): number {
  return sourceAtPlayed(audioTiming(clip, outSec), t - clip.startSec)
}

/** Whether timeline second `t` falls inside one of the clip's holds — where it
 *  is silent, in the preview and the export alike. */
export function audioHeldAt(clip: Timed, outSec: number, t: number): boolean {
  return heldAtPlayed(audioTiming(clip, outSec), t - clip.startSec)
}

/**
 * The TIMELINE second at which the clip plays source second `sourceSec` (for a
 * point a hold sits on, the hold's start). Not clamped to the clip's window,
 * so a point outside it still maps (the volume line's off-window neighbours).
 */
export function audioTimelineAt(clip: Timed, sourceSec: number): number {
  // The out-point plays no part in this direction of the mapping.
  return clip.startSec + playedAtSource(audioTiming(clip, sourceSec), sourceSec)
}

/** One hold on the timeline: silent over `[startSec, endSec)`. */
export interface AudioHoldSpan {
  index: number
  atSec: number
  holdSec: number
  startSec: number
  endSec: number
}

/** Where each of the clip's holds sits on the timeline, in `atSec` order. */
export function audioHoldSpans(clip: Timed, outSec: number): AudioHoldSpan[] {
  return holdSpans(audioTiming(clip, outSec)).map((h) => ({
    index: h.index,
    atSec: h.atSec,
    holdSec: h.holdSec,
    startSec: clip.startSec + h.startPlayed,
    endSec: clip.startSec + h.endPlayed
  }))
}

/**
 * The clip's holds as the EXPORT cuts them: each at its position in the
 * tempo-adjusted audio (played seconds from the clip's start, holds NOT
 * included — the stream the pieces are cut from has none yet), in order.
 * Holds outside the window are left out. @see `buildAudioGraph`
 */
export function audioExportHolds(clip: Timed, outSec: number): { atPlayedSec: number; holdSec: number }[] {
  const t = audioTiming(clip, outSec)
  return [...(clip.freezes ?? [])]
    .filter((f: FreezeHold) => f.holdSec > 0 && f.atSec >= clip.inSec && f.atSec <= outSec)
    .sort((a, b) => a.atSec - b.atSec)
    .map((f) => ({ atPlayedSec: playedBetween(t, clip.inSec, f.atSec), holdSec: f.holdSec }))
}

/**
 * How far (SOURCE seconds) the preview's `<audio>` may drift from the clip's
 * mapped source position before it is re-seeked. While playing, the element
 * advances `speed` source seconds per timeline second, so the allowance grows
 * with the rate (0.3 s of source at 1×, a constant 0.3 s of TIMELINE time when
 * faster); paused or scrubbing it stays tight. Slower than 1× keeps 0.3 s.
 */
export function audioResyncSec(speed: number, playing: boolean): number {
  return playing ? 0.3 * Math.max(1, speed) : 0.05
}
