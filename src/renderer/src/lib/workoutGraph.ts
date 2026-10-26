/**
 * The workout GRAPH WINDOW's edits (docs/WORKOUT-OVERLAY.md "The graph
 * window"): like Quick cut, it edits a working copy — here, the workout tiles
 * of ONE recording on the timeline being edited — and Save swaps the result
 * in as one undo step. Every tile is a RANGE of the recording; the edits are
 * the timeline's own (`splitWorkout`, `trimWorkoutStart` / `trimWorkoutEnd`,
 * `withWorkoutSpeed` from shared/workoutOverlay.ts), driven in RIDE time, so a
 * cut in the graph is exactly the cut S or an edge drag makes on the timeline.
 *
 * A range linked to a clip (a synced overlay) is shown but never edited here:
 * cutting it would leave it out of step with its footage.
 */

import type { Composition, Layer, WorkoutContent } from '@shared/project'
import {
  MIN_WORKOUT_TILE_SEC,
  splitWorkout,
  trimWorkoutEnd,
  trimWorkoutStart,
  withWorkoutSpeed,
  workoutSpeed,
  workoutTimelineSec
} from '@shared/workoutOverlay'

export type WorkoutTile = Layer & { content: WorkoutContent }

const isWorkoutOf =
  (mediaId: string) =>
  (l: Layer): l is WorkoutTile =>
    l.content.kind === 'workout' && l.content.mediaId === mediaId

/** The tiles showing `mediaId`'s recording, in recording order. */
export function workoutTilesOf(comp: Pick<Composition, 'layers'>, mediaId: string): WorkoutTile[] {
  return comp.layers.filter(isWorkoutOf(mediaId)).sort((a, b) => a.content.inSec - b.content.inSec)
}

/** Why a range can't be cut here, or null. */
export function rangeLocked(tile: Layer): string | null {
  return tile.linkGroupId ? 'Linked to a clip: edit it on the timeline (or unlink it first).' : null
}

/** The range showing ride second `sec` (the first, when ranges overlap), or −1. */
export function rangeAt(tiles: WorkoutTile[], sec: number): number {
  return tiles.findIndex((t) => sec >= t.content.inSec && sec < t.content.outSec)
}

const asTile = (l: Layer): WorkoutTile => l as WorkoutTile

/** Split range `i` at ride second `sec` (null when it is locked or the cut is
 *  too near an end for two tiles). */
export function splitRangeAt(tiles: WorkoutTile[], i: number, sec: number, makeId: () => string): WorkoutTile[] | null {
  const t = tiles[i]
  if (!t || rangeLocked(t)) return null
  // Both halves at least the shortest tile.
  const room = MIN_WORKOUT_TILE_SEC * workoutSpeed(t.content)
  if (sec - t.content.inSec < room || t.content.outSec - sec < room) return null
  const halves = splitWorkout(t, t.content, workoutTimelineSec(t.content, t, sec), makeId)
  if (!halves) return null
  return [...tiles.slice(0, i), ...halves.map(asTile), ...tiles.slice(i + 1)]
}

/** Range `i` with its `edge` moved to ride second `toSec` (as far as the
 *  recording and the timeline allow), or the tiles unchanged when locked. */
export function trimRangeEdge(
  tiles: WorkoutTile[],
  i: number,
  edge: 'in' | 'out',
  toSec: number,
  rideDurSec: number
): WorkoutTile[] {
  const t = tiles[i]
  if (!t || rangeLocked(t)) return tiles
  const c = t.content
  // The timeline edits take TIMELINE deltas: where that ride moment would sit
  // on the tile, minus the edge's own place.
  const next =
    edge === 'in'
      ? trimWorkoutStart(t, c, workoutTimelineSec(c, t, toSec) - t.startSec)
      : trimWorkoutEnd(t, c, workoutTimelineSec(c, t, toSec) - t.endSec, rideDurSec)
  return tiles.map((x, j) => (j === i ? asTile(next) : x))
}

/** Delete range `i` (null when it is locked, or the last one: deleting the
 *  overlay itself is the timeline's job). */
export function deleteRange(tiles: WorkoutTile[], i: number): WorkoutTile[] | null {
  const t = tiles[i]
  if (!t || rangeLocked(t) || tiles.length <= 1) return null
  return tiles.filter((_, j) => j !== i)
}

/** Range `i` at a new speed (its window kept; its tile's end follows). */
export function setRangeSpeed(tiles: WorkoutTile[], i: number, speed: number): WorkoutTile[] {
  const t = tiles[i]
  if (!t || rangeLocked(t)) return tiles
  return tiles.map((x, j) => (j === i ? asTile(withWorkoutSpeed(t, t.content, speed)) : x))
}

/** Whether the working copy differs from what is on the timeline. */
export const rangesChanged = (before: WorkoutTile[], after: WorkoutTile[]): boolean =>
  JSON.stringify(before) !== JSON.stringify(after)

/**
 * Save: `comp` with the tiles `before` replaced by `after`, as the timeline's
 * own edits would leave the stack: a tile that is still there keeps its place
 * (edited), a deleted one goes, and a new one (the right half of a split)
 * goes straight after the tile before it in recording order — its left half —
 * as S puts it on the timeline. Everything else is untouched.
 */
export function applyRanges(comp: Composition, before: WorkoutTile[], after: WorkoutTile[]): Composition {
  const was = new Set(before.map((t) => t.id))
  const now = new Map(after.map((t) => [t.id, t]))
  const first = comp.layers.findIndex((l) => was.has(l.id))
  if (first < 0) return comp
  const layers: Layer[] = []
  let anchor = -1 // where a new tile with nothing before it goes: the first old tile's place
  comp.layers.forEach((l, i) => {
    if (i === first) anchor = layers.length
    if (!was.has(l.id)) layers.push(l)
    else if (now.has(l.id)) layers.push(now.get(l.id)!)
  })
  after.forEach((t, i) => {
    if (was.has(t.id)) return
    const prev = after[i - 1]
    const at = prev ? layers.findIndex((l) => l.id === prev.id) : -1
    layers.splice(at >= 0 ? at + 1 : Math.max(0, anchor), 0, t)
  })
  return { ...comp, layers }
}

/** Whether the tiles on the timeline are still what the window opened with
 *  (the assistant may edit the project while it is open). */
export const rangesStillMatch = (comp: Pick<Composition, 'layers'>, before: WorkoutTile[]): boolean =>
  !!before[0] && !rangesChanged(workoutTilesOf(comp, before[0].content.mediaId), before)
