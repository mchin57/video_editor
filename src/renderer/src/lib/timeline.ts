/**
 * Pure timeline math: a single track of clips played back-to-back. Timeline time
 * is seconds from 0; each clip contributes (outSec - inSec) seconds of its source
 * media. Kept dependency-free so it can be unit-tested and reused by the playback
 * engine and the export builder.
 */

import type { Clip } from '@shared/project'

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.outSec - clip.inSec)
}

export function timelineDuration(clips: Clip[]): number {
  return clips.reduce((sum, c) => sum + clipDuration(c), 0)
}

/** Start offset (timeline seconds) of each clip, in clip order. */
export function clipStartTimes(clips: Clip[]): number[] {
  const starts: number[] = []
  let acc = 0
  for (const c of clips) {
    starts.push(acc)
    acc += clipDuration(c)
  }
  return starts
}

export interface TimelinePosition {
  /** Index of the clip playing at the queried time. */
  index: number
  clip: Clip
  /** Time within the source media (inSec + offset) to seek the player to. */
  sourceTime: number
  /** Time within the clip itself (0..clipDuration). */
  localTime: number
}

/**
 * Map a timeline time to the clip playing then. A time landing exactly on a
 * boundary belongs to the later clip; times past the end clamp to the last clip.
 */
export function locate(clips: Clip[], t: number): TimelinePosition | null {
  if (clips.length === 0) return null
  const clamped = Math.max(0, t)
  let acc = 0
  for (let i = 0; i < clips.length; i++) {
    const d = clipDuration(clips[i])
    const isLast = i === clips.length - 1
    if (clamped < acc + d || isLast) {
      const localTime = Math.min(Math.max(0, clamped - acc), d)
      return { index: i, clip: clips[i], sourceTime: clips[i].inSec + localTime, localTime }
    }
    acc += d
  }
  return null
}

/**
 * Split a clip at a time local to the clip (seconds from its start). Returns
 * [left, right] sharing the same source, or null if the cut is at/over an edge.
 */
export function splitClip(clip: Clip, localTime: number, makeId: () => string): [Clip, Clip] | null {
  const d = clipDuration(clip)
  if (localTime <= 0 || localTime >= d) return null
  const cut = clip.inSec + localTime
  const left: Clip = { ...clip, outSec: cut }
  const right: Clip = { ...clip, id: makeId(), inSec: cut }
  return [left, right]
}

/** Move the clip at `from` to index `to`, returning a new array. */
export function reorder<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return items
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
