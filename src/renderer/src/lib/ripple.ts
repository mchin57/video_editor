/**
 * RIPPLE — moving "everything from this point on" as one, the primitive behind
 * insert-between (and, later, ripple delete / ripple trim / close gaps).
 *
 * The rules (`docs/TIMELINE.md` "Insert between"; `lib/ripple.test.ts` pins them):
 *
 * - **Every lane moves.** A tile on any lane that starts at or after the point
 *   belongs to "from this point on" (`tilesFrom`), so picture, sound, captions
 *   and text stay together.
 * - **A tile that spans the point stays where it is, uncut** (a music bed, a
 *   long title): only where a tile STARTS decides.
 * - **A link group is one thing.** It moves whole when its earliest member
 *   starts at or after the point, and stays whole otherwise — so a tile after
 *   the point stays behind when it is linked to one before it (a J-cut's
 *   picture, whose sound starts earlier).
 * - **Script lines pinned at or after the point move too.** They live on the
 *   project root only, so a nested composition has none to move.
 *
 * `openGap` / `closeGap` are the two moves; `makeRoomFor` (insert something
 * new) and `moveToSeam` (lift tiles out and insert them elsewhere) are built on
 * them, and `seamNear` finds the insert point a pointer means. Everything is
 * pure over a `Composition` and goes through `timelineTiles` / `moveItemsBy`
 * (`lib/links.ts`), so the same code serves the root timeline and a nested comp.
 */

import type { Composition, Project, ScriptLine, TimelineItemRef } from '@shared/project'
import { moveItemsBy, refKey, refKeys, timelineTiles, type SourceDuration, type Tile, type TileLane } from './links'

/** Time tolerance, the same one the splits and `snapToPreviousDelta` use. */
const EPS = 1e-3

/** How far apart (seconds) two tiles in a lane may sit and still meet at a
 *  seam: less than a frame, so a hand-placed neighbour still counts. */
export const SEAM_GAP_SEC = 0.02

/**
 * The tiles that count as "from `atSec` on", in document order: every tile
 * that starts at or after it, with link groups taken whole (a group counts only
 * when its EARLIEST member does). Tiles in `skip` are left out entirely — as
 * movers and as group members (the tiles being inserted or lifted).
 */
export function tilesFrom(c: Composition, atSec: number, skip: TimelineItemRef[] = []): TimelineItemRef[] {
  const skipped = refKeys(skip)
  const tiles = timelineTiles(c).filter((t) => !skipped.has(refKey(t.ref)))
  const groupStart = new Map<string, number>()
  for (const t of tiles) {
    if (t.linkGroupId) groupStart.set(t.linkGroupId, Math.min(groupStart.get(t.linkGroupId) ?? Infinity, t.startSec))
  }
  const startOf = (t: Tile): number => (t.linkGroupId ? groupStart.get(t.linkGroupId)! : t.startSec)
  return tiles.filter((t) => startOf(t) >= atSec - EPS).map((t) => t.ref)
}

/** The window a set of tiles covers: its earliest start to its latest KNOWN
 *  end (an open-ended audio tile, source length unknown, has none). Null for
 *  no tiles. */
export function tilesSpan(tiles: Tile[]): { startSec: number; endSec: number } | null {
  if (tiles.length === 0) return null
  const startSec = Math.min(...tiles.map((t) => t.startSec))
  const ends = tiles.map((t) => t.endSec).filter(Number.isFinite)
  return { startSec, endSec: Math.max(startSec, ...ends) }
}

/**
 * `c` with every pinned script line's time sent through `fn`. Script lines are
 * ROOT-only (`Project.script`): the active composition is the project itself
 * when the root is being edited, and a nested composition carries none — so
 * rippling the comp being edited moves exactly the lines on its own timeline.
 */
function mapScript<C extends Composition>(c: C, fn: (atSec: number) => number): C {
  const script = (c as Partial<Project>).script
  if (!script) return c
  let changed = false
  const next = script.map((l): ScriptLine => {
    if (l.atSec == null) return l
    const atSec = fn(l.atSec)
    if (atSec === l.atSec) return l
    changed = true
    return { ...l, atSec }
  })
  return changed ? { ...c, script: next } : c
}

/** The tiles from `atSec` on, shifted by `delta` (tiles only). */
function shiftTilesFrom<C extends Composition>(c: C, atSec: number, delta: number, skip: TimelineItemRef[]): C {
  return moveItemsBy(c, tilesFrom(c, atSec, skip), delta) as C
}

/** Where a time lands when `lengthSec` opens at `atSec`. */
const opened =
  (atSec: number, lengthSec: number) =>
  (t: number): number =>
    t >= atSec - EPS ? t + lengthSec : t

/** Where a time lands when `lengthSec` closes at `atSec`: a time inside the
 *  closed stretch lands on its start. */
const closed =
  (atSec: number, lengthSec: number) =>
  (t: number): number =>
    t >= atSec - EPS ? Math.max(atSec, t - lengthSec) : t

/**
 * Open `lengthSec` of room at `atSec`: everything from there on (`tilesFrom`,
 * and the script lines pinned there) moves later by it. Returns `c` unchanged
 * when nothing moves.
 */
export function openGap<C extends Composition>(
  c: C,
  atSec: number,
  lengthSec: number,
  skip: TimelineItemRef[] = []
): C {
  if (!(lengthSec > 0)) return c
  const at = Math.max(0, atSec)
  return mapScript(shiftTilesFrom(c, at, lengthSec, skip), opened(at, lengthSec))
}

/**
 * How much of `lengthSec` a close at `atSec` can take: the tiles from there on
 * move as ONE set (so they stay in sync), and the set stops when its earliest
 * tile reaches 0.
 */
export function closableGap(c: Composition, atSec: number, lengthSec: number, skip: TimelineItemRef[] = []): number {
  if (!(lengthSec > 0)) return 0
  const keys = refKeys(tilesFrom(c, Math.max(0, atSec), skip))
  const starts = timelineTiles(c)
    .filter((t) => keys.has(refKey(t.ref)))
    .map((t) => t.startSec)
  return Math.min(lengthSec, ...starts)
}

/**
 * Close `lengthSec` at `atSec` — `openGap`'s inverse: everything from there on
 * moves EARLIER by it, never past 0 (`closableGap`), with the same spanning and
 * link-group rules. A script line pinned inside the closed stretch lands on its
 * start. Nothing is removed: a tile that started inside the stretch moves with
 * the rest, so close a stretch the lane no longer needs.
 */
export function closeGap<C extends Composition>(
  c: C,
  atSec: number,
  lengthSec: number,
  skip: TimelineItemRef[] = []
): C {
  const at = Math.max(0, atSec)
  const d = closableGap(c, at, lengthSec, skip)
  if (!(d > 0)) return c
  return mapScript(shiftTilesFrom(c, at, -d, skip), closed(at, d))
}

/**
 * Move `also` (a clip's whole link group) and everything from `atSec` on by
 * `delta` as ONE set, with the script lines pinned at or after `atSec` — the
 * slide that makes or resizes a transition's overlap (`lib/transitions.ts`:
 * the incoming clip, its group and everything after it move left, so the reel
 * gets shorter). Unlike `closeGap` nothing is clamped: when the set's earliest
 * tile would pass 0, `c` comes back unchanged (callers measure the room first
 * with `roomBefore`).
 */
export function shiftFrom<C extends Composition>(c: C, atSec: number, delta: number, also: TimelineItemRef[] = []): C {
  if (delta === 0) return c
  const at = Math.max(0, atSec)
  const movers = [...also, ...tilesFrom(c, at, also)]
  if (delta < 0 && roomBefore(c, movers) < -delta - EPS) return c
  return mapScript(moveItemsBy(c, movers, delta) as C, (t) => (t >= at - EPS ? Math.max(0, t + delta) : t))
}

/** How far `refs` can move left as one set: their earliest start (they stop
 *  together at 0). Infinity for no tiles. */
export function roomBefore(c: Composition, refs: TimelineItemRef[]): number {
  const keys = refKeys(refs)
  return Math.min(
    Infinity,
    ...timelineTiles(c)
      .filter((t) => keys.has(refKey(t.ref)))
      .map((t) => t.startSec)
  )
}

/**
 * Make room for tiles that were just added at `atSec`: `after` is `before`
 * plus the new tiles, and everything else from `atSec` on moves later by how
 * far the new tiles reach past it — the new item's length (a clip with sound:
 * its link group's span). `srcDur` bounds a new whole-source audio clip.
 */
export function makeRoomFor<C extends Composition>(
  before: Composition,
  after: C,
  atSec: number,
  srcDur?: SourceDuration
): C {
  const had = refKeys(timelineTiles(before).map((t) => t.ref))
  const fresh = timelineTiles(after, srcDur).filter((t) => !had.has(refKey(t.ref)))
  const span = tilesSpan(fresh)
  if (!span) return after
  const at = Math.max(0, atSec)
  return openGap(
    after,
    at,
    span.endSec - at,
    fresh.map((t) => t.ref)
  )
}

/**
 * Close the hole a lifted set left at `[atSec, atSec + lengthSec)`: every tile
 * (or link group) from `atSec` on moves earlier by `lengthSec`, EACH stopping
 * at 0 on its own. Unlike `closeGap`, one tile near the start does not hold
 * the rest back — a music bed or title that starts at 0 beside the lifted clip
 * stays put while the clips after the hole still close up in full (they start
 * at least `lengthSec` in, so they always can).
 */
function closeHole<C extends Composition>(c: C, atSec: number, lengthSec: number, skip: TimelineItemRef[]): C {
  const keys = refKeys(tilesFrom(c, atSec, skip))
  const groups = new Map<string, TimelineItemRef[]>()
  for (const t of timelineTiles(c)) {
    if (!keys.has(refKey(t.ref))) continue
    const g = t.linkGroupId ?? refKey(t.ref)
    groups.set(g, [...(groups.get(g) ?? []), t.ref])
  }
  let next = c
  // `moveItemsBy` clamps each set at 0 by its earliest member.
  for (const refs of groups.values()) next = moveItemsBy(next, refs, -lengthSec) as C
  return next
}

/**
 * Lift the tiles `refs` out and insert them at `seamSec` (a time on the
 * timeline as it is now): the hole they leave is closed (`closeHole` over their
 * span, from their start), room for them is opened at the seam, and they land
 * there — offsets inside the set kept. Script lines pinned inside the set's
 * span ride with it.
 *
 * Returns `c` unchanged when the set has no length, when the seam lies inside
 * the set's own span, or when it would land where it already is.
 */
export function moveToSeam<C extends Composition>(
  c: C,
  refs: TimelineItemRef[],
  seamSec: number,
  srcDur?: SourceDuration
): C {
  const keys = refKeys(refs)
  const set = timelineTiles(c, srcDur).filter((t) => keys.has(refKey(t.ref)))
  const span = tilesSpan(set)
  if (!span) return c
  const { startSec: from, endSec: end } = span
  const len = end - from
  const seam = Math.max(0, seamSec)
  if (!(len > 0) || (seam > from + EPS && seam < end - EPS)) return c
  const lifted = set.map((t) => t.ref)
  // A seam before the hole stays put; one after it moves left as the hole closes.
  // The hole always closes in full: everything past it starts at least `len`
  // in, so it can move the whole way (see `closeHole`).
  const to = seam <= from + EPS ? seam : seam - len
  if (Math.abs(to - from) < EPS) return c

  let next = closeHole(c, from, len, lifted)
  next = shiftTilesFrom(next, to, len, lifted)
  next = moveItemsBy(next, lifted, to - from) as C
  const close = closed(from, len)
  const open = opened(to, len)
  return mapScript(next, (t) => (t >= from - EPS && t < end - EPS ? t + (to - from) : open(close(t))))
}

/**
 * The insert point a pointer at `atSec` means, or null when it is not on one.
 * A seam is where two tiles in `lane` meet (one ends as another starts, within
 * `SEAM_GAP_SEC`; the point is the later tile's start), or the very start of
 * the timeline — which counts in any lane, and with no lane at all. The
 * nearest seam within `tolSec` wins.
 */
export function seamNear(tiles: Tile[], lane: TileLane | null, atSec: number, tolSec: number): number | null {
  const inLane = lane ? tiles.filter((t) => t.lane === lane) : []
  const seams = [
    0,
    ...inLane
      .filter((b) => inLane.some((a) => a !== b && Math.abs(a.endSec - b.startSec) <= SEAM_GAP_SEC))
      .map((b) => b.startSec)
  ]
  let best: number | null = null
  for (const s of seams) {
    const d = Math.abs(s - atSec)
    if (d <= tolSec && (best === null || d < Math.abs(best - atSec))) best = s
  }
  return best
}
