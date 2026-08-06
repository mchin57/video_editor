/**
 * LINK GROUPS — the pure logic behind the timeline's Link / Unlink.
 *
 * A link group is a set of timeline tiles (`TimelineItemRef`: a video/image/text
 * layer, a caption segment, or an audio clip) that behave as one:
 *
 * - **Selection is all-or-nothing.** There is no selecting a single member;
 *   clicking one selects the group (`expandSelection`).
 * - **Movement is a shared delta.** Every member shifts by the same amount, so
 *   relative offsets and per-tile durations are preserved exactly
 *   (`moveItemsBy`). One clamp for the whole set: the earliest member stops at 0.
 * - **Splitting happens at the PLAYHEAD, per member.** Members the playhead
 *   crosses are cut; members it misses are left alone (`splitItemsAt`). The
 *   right-hand halves form a NEW group so the two sides of a cut can be edited
 *   independently afterwards.
 * - **Deleting takes the whole group** (`removeItems`).
 *
 * Membership lives on the tiles themselves (`linkGroupId`, one id space across
 * `layers` / `captions.segments` / `audioClips`) rather than in a group table:
 * a split or a copy carries the field along for free, and a deleted member can't
 * leave a dangling reference. A group with fewer than two surviving members is
 * treated as unlinked everywhere here and pruned on the next structural edit
 * (`pruneLinkGroups`), so a stale id can never change behavior.
 *
 * Layout layers are NOT linkable (their cells have their own internal timing;
 * nothing about a group would translate onto them) — `timelineTiles` marks them
 * and `linkItems` drops them.
 *
 * Nothing outside the timeline reads link groups: the exporter sees only the
 * final positions, so this is renderer-only (like `lib/timeline.ts`). Typed against `Composition`, so the SAME ops serve the root timeline and any nested comp.
 */

import type {
  AudioClip,
  CaptionSegment,
  Layer,
  Composition,
  TimelineItemKind,
  TimelineItemRef
} from '@shared/project'
import { audioClipEnd } from '@shared/project'
import {
  splitAudioClip,
  splitCaptionSegment,
  splitStaticLayer,
  splitVideoLayer,
  trimAudioEdge,
  trimCaptionEdge,
  trimLayerEdge,
  type Trimmed,
  type TrimEdge
} from './timeline'

/** Cut tolerance — mirrors the guards in the `split*` helpers so `splittableAt`
 *  can't claim a cut they refuse to make (a test pins that they agree). */
const EPS = 1e-3

/** Stable identity of a tile across the three arrays (ids are only unique
 *  within their own array). */
export const refKey = (ref: TimelineItemRef): string => `${ref.kind}:${ref.id}`

export const sameRef = (a: TimelineItemRef, b: TimelineItemRef): boolean =>
  a.kind === b.kind && a.id === b.id

/** A lookup set for "is this tile in that list of refs". */
export const refKeys = (refs: TimelineItemRef[]): Set<string> => new Set(refs.map(refKey))

/** Resolves an asset's source duration in seconds (0 = unknown). Audio clips
 *  with no explicit out-point end at the source end, which only the library
 *  knows — callers pass a lookup over it. */
export type SourceDuration = (mediaId: string) => number

/**
 * One timeline tile, flattened out of whichever array it lives in — the common
 * shape every group operation works against, so the three-array walk exists in
 * exactly one place.
 */
export interface Tile {
  ref: TimelineItemRef
  startSec: number
  /** Timeline end. `Infinity` for a whole-source audio clip whose source
   *  duration isn't known yet (matching `splitAudioClip`'s tolerance). */
  endSec: number
  linkGroupId?: string
  /** Whether this tile may join a link group (layout layers may not). */
  linkable: boolean
  /**
   * Whether a cut strictly inside it yields two tiles. True for everything but a
   * layout (whose cells carry their own trims) — video layers via
   * `splitVideoLayer`, text/image via `splitStaticLayer`, captions via
   * `splitCaptionSegment`, audio via `splitAudioClip`. Coincides with `linkable`
   * today, but they answer different questions: keep them apart.
   */
  splittable: boolean
}

/** Timeline end of an audio tile, tolerating an unknown source duration exactly
 *  the way `splitAudioClip` does (an explicit out-point wins; a whole-source
 *  clip with no known duration is open-ended). */
function audioTileEnd(a: AudioClip, sourceDurationSec: number): number {
  if (a.outSec > 0) return a.startSec + Math.max(0, a.outSec - a.inSec)
  return sourceDurationSec > 0 ? audioClipEnd(a, sourceDurationSec) : Infinity
}

/** Every timeline tile in document order: layers (stack order), then captions,
 *  then audio clips. `srcDur` is only needed to bound audio tiles. */
export function timelineTiles(p: Composition, srcDur: SourceDuration = () => 0): Tile[] {
  const tiles: Tile[] = []
  for (const l of p.layers) {
    tiles.push({
      ref: { kind: 'layer', id: l.id },
      startSec: l.startSec,
      endSec: l.endSec,
      linkGroupId: l.linkGroupId,
      linkable: l.content.kind !== 'layout',
      splittable: l.content.kind !== 'layout'
    })
  }
  for (const s of p.captions.segments) {
    tiles.push({
      ref: { kind: 'caption', id: s.id },
      startSec: s.startSec,
      endSec: s.endSec,
      linkGroupId: s.linkGroupId,
      linkable: true,
      splittable: true
    })
  }
  for (const a of p.audioClips) {
    tiles.push({
      ref: { kind: 'audio', id: a.id },
      startSec: a.startSec,
      endSec: audioTileEnd(a, srcDur(a.mediaId)),
      linkGroupId: a.linkGroupId,
      linkable: true,
      splittable: true
    })
  }
  return tiles
}

/** The tile a ref points at, or null if it no longer exists. */
export function tileOf(
  p: Composition,
  ref: TimelineItemRef,
  srcDur?: SourceDuration
): Tile | null {
  return timelineTiles(p, srcDur).find((t) => sameRef(t.ref, ref)) ?? null
}

/**
 * Grow a selection to whole link groups, deduped and in document order: every
 * ref is replaced by all members of its group. Refs that no longer exist drop
 * out, and a group with only one surviving member contributes just that tile.
 */
export function expandSelection(p: Composition, refs: TimelineItemRef[]): TimelineItemRef[] {
  const tiles = timelineTiles(p)
  const wanted = new Set<string>()
  for (const ref of refs) {
    const self = tiles.find((t) => sameRef(t.ref, ref))
    if (!self) continue
    const gid = self.linkGroupId
    const members = gid ? tiles.filter((t) => t.linkGroupId === gid) : [self]
    for (const m of members.length > 1 ? members : [self]) wanted.add(refKey(m.ref))
  }
  return tiles.filter((t) => wanted.has(refKey(t.ref))).map((t) => t.ref)
}

/** Every member of the group `ref` belongs to (including `ref`), in document
 *  order; just `[ref]` when it's unlinked, and `[]` if it no longer exists. */
export function expandGroup(p: Composition, ref: TimelineItemRef): TimelineItemRef[] {
  return expandSelection(p, [ref])
}

/** Whether this tile is in a link group with at least one other member. */
export function isLinked(p: Composition, ref: TimelineItemRef): boolean {
  return expandGroup(p, ref).length > 1
}

/** The linkable tiles among `refs`, deduped (drops layouts and stale refs). */
function linkTargets(p: Composition, refs: TimelineItemRef[]): Tile[] {
  const keys = refKeys(refs)
  return timelineTiles(p).filter((t) => t.linkable && keys.has(refKey(t.ref)))
}

/** Whether Link would change anything: at least two linkable tiles that aren't
 *  already exactly one group. */
export function canLinkItems(p: Composition, refs: TimelineItemRef[]): boolean {
  const targets = linkTargets(p, refs)
  if (targets.length < 2) return false
  const gids = new Set(targets.map((t) => t.linkGroupId))
  if (gids.size > 1) return true
  const gid = targets[0].linkGroupId
  if (!gid) return true
  // All in one group already — a no-op unless the group has outside members
  // (which linking would pull in).
  return timelineTiles(p).filter((t) => t.linkGroupId === gid).length !== targets.length
}

/** Whether any of `refs` is actually linked (so Unlink has something to do). */
export function canUnlinkItems(p: Composition, refs: TimelineItemRef[]): boolean {
  return refs.some((r) => isLinked(p, r))
}

/**
 * Rewrite every tile's `linkGroupId` through `next(ref, current)` — return
 * `undefined` to unlink. Returns `p` unchanged when no id moved, so callers
 * no-op for free (and can't push an empty undo step).
 */
function setGroupIds(
  p: Composition,
  next: (ref: TimelineItemRef, current: string | undefined) => string | undefined
): Composition {
  let changed = false
  const apply = <T extends { id: string; linkGroupId?: string }>(
    item: T,
    kind: TimelineItemKind
  ): T => {
    const gid = next({ kind, id: item.id }, item.linkGroupId)
    if (gid === item.linkGroupId) return item
    changed = true
    const copy = { ...item }
    if (gid === undefined) delete copy.linkGroupId
    else copy.linkGroupId = gid
    return copy
  }
  const layers = p.layers.map((l) => apply(l, 'layer'))
  const segments = p.captions.segments.map((s) => apply(s, 'caption'))
  const audioClips = p.audioClips.map((a) => apply(a, 'audio'))
  if (!changed) return p
  return { ...p, layers, captions: { ...p.captions, segments }, audioClips }
}

/** Clear `linkGroupId` wherever a group has fewer than two surviving members. */
export function pruneLinkGroups(p: Composition): Composition {
  const counts = new Map<string, number>()
  for (const t of timelineTiles(p)) {
    if (t.linkGroupId) counts.set(t.linkGroupId, (counts.get(t.linkGroupId) ?? 0) + 1)
  }
  return setGroupIds(p, (_ref, gid) => (gid && (counts.get(gid) ?? 0) > 1 ? gid : undefined))
}

/**
 * Put every linkable tile in `refs` into ONE new group. Groups the targets were
 * already in are absorbed whole, so linking a tile that already has partners
 * brings them along instead of tearing them apart. No-ops (returns `p`) when
 * fewer than two linkable tiles remain — layout layers are never linked.
 */
export function linkItems(
  p: Composition,
  refs: TimelineItemRef[],
  makeId: () => string
): Composition {
  // `canLinkItems` is the single authority for "would this change anything", so
  // the disabled Link button and this action can't drift apart (and re-linking
  // one existing group doesn't churn its id into a pointless undo step).
  if (!canLinkItems(p, refs)) return p
  const targets = linkTargets(p, refs)
  const keys = refKeys(targets.map((t) => t.ref))
  const absorbed = new Set(targets.map((t) => t.linkGroupId).filter((g): g is string => !!g))
  const gid = makeId()
  return setGroupIds(p, (ref, current) =>
    keys.has(refKey(ref)) || (current && absorbed.has(current)) ? gid : current
  )
}

/** Unlink every group represented in `refs` — all of their members, not just
 *  the tiles passed in (a group is only ever broken as a whole). */
export function unlinkItems(p: Composition, refs: TimelineItemRef[]): Composition {
  const keys = refKeys(refs)
  const dropped = new Set(
    timelineTiles(p)
      .filter((t) => keys.has(refKey(t.ref)))
      .map((t) => t.linkGroupId)
      .filter((g): g is string => !!g)
  )
  if (dropped.size === 0) return p
  return setGroupIds(p, (_ref, current) => (current && dropped.has(current) ? undefined : current))
}

/**
 * Shift every tile in `refs` by `delta` seconds, preserving each one's duration
 * and every offset between them. A single clamp applies to the whole set — the
 * earliest tile stops at 0 and the rest keep their relative placement, so a
 * group can't be squashed by dragging it into the start of the timeline.
 */
export function moveItemsBy(p: Composition, refs: TimelineItemRef[], delta: number): Composition {
  const keys = refKeys(refs)
  const moving = timelineTiles(p).filter((t) => keys.has(refKey(t.ref)))
  if (moving.length === 0) return p
  const d = Math.max(delta, -Math.min(...moving.map((t) => t.startSec)))
  if (d === 0) return p
  return {
    ...p,
    layers: p.layers.map((l) =>
      keys.has(refKey({ kind: 'layer', id: l.id }))
        ? { ...l, startSec: l.startSec + d, endSec: l.endSec + d }
        : l
    ),
    captions: {
      ...p.captions,
      segments: p.captions.segments.map((s) =>
        keys.has(refKey({ kind: 'caption', id: s.id }))
          ? { ...s, startSec: s.startSec + d, endSec: s.endSec + d }
          : s
      )
    },
    audioClips: p.audioClips.map((a) =>
      keys.has(refKey({ kind: 'audio', id: a.id })) ? { ...a, startSec: a.startSec + d } : a
    )
  }
}

/**
 * Trim the same `edge` of every tile in `refs` by the same TIMELINE delta — the
 * trim counterpart of `moveItemsBy`. Each member converts that delta through its
 * own mapping (a video walks its speed profile and freeze holds, an audio clip
 * moves its in/out point), so members of different lengths and speeds stay in
 * step: a 3s trim off the right edge takes 3s off every member.
 *
 * The delta is clamped to what the most constrained member can give, measured by
 * trimming each once and reading back how far its edge actually moved. Letting
 * each member clamp itself would silently desync the group the moment one ran out
 * of source — the same reason `moveItemsBy` clamps the SET at 0.
 */
export function trimItemsBy(
  p: Composition,
  refs: TimelineItemRef[],
  edge: TrimEdge,
  delta: number,
  srcDur: SourceDuration = () => 0
): Composition {
  const keys = refKeys(refs)
  if (keys.size === 0 || delta === 0) return p
  const has = (kind: TimelineItemKind, id: string): boolean => keys.has(refKey({ kind, id }))
  const layerSrc = (l: Layer): number =>
    l.content.kind === 'video' ? srcDur(l.content.mediaId) : 0
  const trimLayer = (l: Layer, d: number): Trimmed<Layer> =>
    trimLayerEdge(l, edge, d, layerSrc(l))
  const trimAudio = (a: AudioClip, d: number): Trimmed<AudioClip> =>
    trimAudioEdge(a, edge, d, srcDur(a.mediaId))

  // Pass 1 — the delta every member can absorb (smallest magnitude wins; a
  // member that can't move at all pins the group at 0).
  let d = delta
  const narrow = (achieved: number): void => {
    if (Math.abs(achieved) < Math.abs(d)) d = achieved
  }
  for (const l of p.layers) if (has('layer', l.id)) narrow(trimLayer(l, delta).achieved)
  for (const s of p.captions.segments) {
    if (has('caption', s.id)) narrow(trimCaptionEdge(s, edge, delta).achieved)
  }
  for (const a of p.audioClips) if (has('audio', a.id)) narrow(trimAudio(a, delta).achieved)
  if (d === 0) return p

  // Pass 2 — apply it. Every member reaches exactly `d` (each trim is monotone
  // in the delta, and `d` is within every member's capacity by construction).
  return {
    ...p,
    layers: p.layers.map((l) => (has('layer', l.id) ? trimLayer(l, d).tile : l)),
    captions: {
      ...p.captions,
      segments: p.captions.segments.map((s) =>
        has('caption', s.id) ? trimCaptionEdge(s, edge, d).tile : s
      )
    },
    audioClips: p.audioClips.map((a) => (has('audio', a.id) ? trimAudio(a, d).tile : a))
  }
}

/** Whether a cut at `atSec` falls strictly inside this tile and the tile
 *  supports splitting at all. */
export function splittableAt(
  p: Composition,
  ref: TimelineItemRef,
  atSec: number,
  srcDur?: SourceDuration
): boolean {
  const t = tileOf(p, ref, srcDur)
  return !!t && t.splittable && atSec > t.startSec + EPS && atSec < t.endSec - EPS
}

/** Whether a split at `atSec` would cut at least one of `refs`. */
export function canSplitItems(
  p: Composition,
  refs: TimelineItemRef[],
  atSec: number,
  srcDur?: SourceDuration
): boolean {
  return refs.some((r) => splittableAt(p, r, atSec, srcDur))
}

/** Replace an item's link group (undefined = unlinked), sharing nothing when
 *  the id is already what we want. */
function withGroup<T extends { linkGroupId?: string }>(item: T, gid: string | undefined): T {
  if (gid === item.linkGroupId) return item
  const copy = { ...item }
  if (gid === undefined) delete copy.linkGroupId
  else copy.linkGroupId = gid
  return copy
}

/**
 * Split every tile in `refs` that the playhead at `atSec` crosses — one edit,
 * one undo step. Tiles the playhead misses (offset in time, or shorter) are
 * left whole, and tiles with no split op (text/image layers, captions) are
 * never cut.
 *
 * The two sides are then separate groups: left halves keep the original group,
 * right halves — plus any member sitting entirely after the cut — move to a new
 * one, so each side can be dragged independently afterwards. Returns `p`
 * unchanged when nothing was actually cut.
 */
export function splitItemsAt(
  p: Composition,
  refs: TimelineItemRef[],
  atSec: number,
  srcDur: SourceDuration,
  makeId: () => string
): Composition {
  const keys = refKeys(refs)
  if (keys.size === 0) return p
  let changed = false
  // One new group id per original group, minted lazily so an unlinked tile
  // stays unlinked.
  const rightGroups = new Map<string, string>()
  const rightGroup = (gid: string | undefined): string | undefined => {
    if (!gid) return undefined
    const existing = rightGroups.get(gid)
    if (existing) return existing
    const next = makeId()
    rightGroups.set(gid, next)
    return next
  }
  /** A member the cut didn't touch belongs with the right-hand halves when it
   *  lives after the playhead, and stays put when it lives before it. */
  const uncut = <T extends { startSec: number; linkGroupId?: string }>(item: T): T =>
    item.startSec >= atSec - EPS ? withGroup(item, rightGroup(item.linkGroupId)) : item

  const layers: Layer[] = []
  for (const l of p.layers) {
    if (!keys.has(refKey({ kind: 'layer', id: l.id }))) {
      layers.push(l)
      continue
    }
    // Video carries a source trim through the cut; text/image are the same
    // content over two windows (with window-anchored motion/animation split).
    const res =
      l.content.kind === 'video'
        ? splitVideoLayer(l, atSec, makeId)
        : splitStaticLayer(l, atSec, makeId)
    if (!res) {
      layers.push(uncut(l))
      continue
    }
    changed = true
    layers.push(res[0], withGroup(res[1], rightGroup(l.linkGroupId)))
  }

  const segments: CaptionSegment[] = []
  for (const s of p.captions.segments) {
    if (!keys.has(refKey({ kind: 'caption', id: s.id }))) {
      segments.push(s)
      continue
    }
    const res = splitCaptionSegment(s, atSec, makeId)
    if (!res) {
      segments.push(uncut(s))
      continue
    }
    changed = true
    segments.push(res[0], withGroup(res[1], rightGroup(s.linkGroupId)))
  }

  const audioClips: AudioClip[] = []
  for (const a of p.audioClips) {
    if (!keys.has(refKey({ kind: 'audio', id: a.id }))) {
      audioClips.push(a)
      continue
    }
    const res = splitAudioClip(a, atSec, srcDur(a.mediaId), makeId)
    if (!res) {
      audioClips.push(uncut(a))
      continue
    }
    changed = true
    audioClips.push(res[0], withGroup(res[1], rightGroup(a.linkGroupId)))
  }

  // No cut, no edit — the re-grouping above only means anything around a cut.
  if (!changed) return p
  return pruneLinkGroups({ ...p, layers, captions: { ...p.captions, segments }, audioClips })
}

/** Delete every tile in `refs`, pruning any group left with a single member. */
export function removeItems(p: Composition, refs: TimelineItemRef[]): Composition {
  const keys = refKeys(refs)
  if (keys.size === 0) return p
  const layers = p.layers.filter((l) => !keys.has(refKey({ kind: 'layer', id: l.id })))
  const segments = p.captions.segments.filter(
    (s) => !keys.has(refKey({ kind: 'caption', id: s.id }))
  )
  const audioClips = p.audioClips.filter((a) => !keys.has(refKey({ kind: 'audio', id: a.id })))
  if (
    layers.length === p.layers.length &&
    segments.length === p.captions.segments.length &&
    audioClips.length === p.audioClips.length
  ) {
    return p
  }
  return pruneLinkGroups({ ...p, layers, captions: { ...p.captions, segments }, audioClips })
}
