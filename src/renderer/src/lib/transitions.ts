/**
 * TRANSITIONS on the timeline (#64) — the pure edits behind Add transition, the
 * wedge drag, the Inspector section and the assistant's `set_transition`. The
 * picture math (ramps, pairs, plates) is in `shared/transitions.ts`; this is
 * what applying, resizing and removing one does to a composition.
 *
 * The rules (docs/TIMELINE.md "Transitions"; `lib/transitions.test.ts` pins them):
 *
 * - **Applying slides the incoming clip in.** Two neighbouring clips (the
 *   second starts where the first ends) get a transition by moving the second
 *   clip, its link group and everything after it LEFT by the transition's
 *   length (`shiftFrom`, lib/ripple.ts), so the tiles overlap by exactly that
 *   much and the reel gets that much shorter. Clips that already overlap (a
 *   transition removed earlier) take the overlap as the length instead.
 * - **The incoming clip ends up above the outgoing one** in the stack (a
 *   dissolve is the incoming clip fading in OVER the outgoing one).
 * - **Their linked sound crossfades** over the same window — only the sound
 *   that meets at the cut (`setCutFades`): the outgoing clip's own sound that
 *   ends where it ends fades out, the incoming clip's own sound that starts
 *   where it starts fades in, by the transition's length (ordinary fade fields,
 *   editable afterwards). A linked sound effect or music bed is left alone. A
 *   length change carries a fade along only while it still equals the old
 *   length.
 * - **Resizing a pair slides the incoming side again** by the change, so the
 *   overlap always equals the length — the incoming clip, its link group and
 *   the tiles after the CUT (the outgoing clip's end, i.e. the incoming
 *   clip's pre-overlap start, which no resize moves). A tile that starts
 *   inside the overlap (an unlinked caption over the outgoing clip's last
 *   words) stays put.
 * - **Removing a transition leaves the overlap** as a plain overlap (both sides
 *   of a pair go; nothing slides back, the fades stay).
 * - Lengths: 0.5 s by default, 0.1–2 s, never more than half the shorter clip.
 */

import type { AudioClip, Composition, Layer, LayerTransition, TimelineItemRef, TransitionKind } from '@shared/project'
import { effectiveOut } from '@shared/project'
import { audioPlayedSec } from '@shared/audioTiming'
import {
  clampTransitionSec,
  maxTransitionSec,
  pairOf,
  takesTransitions,
  transitionOf,
  TRANSITION_DEFAULT_SEC,
  TRANSITION_KINDS,
  TRANSITION_MIN_SEC,
  withTransition,
  type TransitionPair,
  type TransitionSide
} from '@shared/transitions'
import { expandGroup, type SourceDuration } from './links'
import { roomBefore, SEAM_GAP_SEC, shiftFrom, tilesFrom } from './ripple'
import { replaceAt, updateById } from './arrays'

const EPS = 1e-6

/** Lengths and fades are kept to the millisecond (float noise from tile maths
 *  stays out of the document). Local on purpose: there is no shared seconds
 *  rounder for the renderer (docs/SHARED.md — `f3` is main's string
 *  formatter, and each pure module keeps its own `r3`). */
const ms = (sec: number): number => Math.round(sec * 1000) / 1000

/** Why Add transition is (not) available for a selection, and what it would do. */
export type TransitionCheck =
  { ok: true; outId: string; inId: string; sec: number; slide: number } | { ok: false; reason: string }

const layerRef = (id: string): TimelineItemRef => ({ kind: 'layer', id })
const tileLen = (l: Layer): number => l.endSec - l.startSec

/** The link group of layer `id` (just the layer when it is unlinked). */
const groupOf = (c: Composition, id: string): TimelineItemRef[] => expandGroup(c, layerRef(id))

/**
 * Whether the tiles `refs` (a selection, link groups included) are two
 * neighbouring clips a transition can join: exactly two video/image tiles, the
 * second starting where the first ends (within a seam's gap) or overlapping it
 * by no more than the longest transition they can take, not linked to each
 * other, with room for the second to slide left.
 */
export function transitionCandidate(c: Composition, refs: TimelineItemRef[]): TransitionCheck {
  const ids = new Set(refs.filter((r) => r.kind === 'layer').map((r) => r.id))
  const picked = c.layers.filter((l) => ids.has(l.id) && takesTransitions(l))
  if (picked.length !== 2) return { ok: false, reason: 'Select two neighbouring video or image clips.' }
  const [a, b] = [...picked].sort((x, y) => x.startSec - y.startSec)
  if (a.linkGroupId && a.linkGroupId === b.linkGroupId) {
    return { ok: false, reason: 'The two clips are linked to each other. Unlink them first.' }
  }
  if (b.startSec <= a.startSec + EPS || b.endSec <= a.endSec + EPS) {
    return { ok: false, reason: 'One clip lies inside the other.' }
  }
  const overlap = a.endSec - b.startSec
  if (overlap < -SEAM_GAP_SEC)
    return { ok: false, reason: 'The clips must meet: the second starts where the first ends.' }
  const max = maxTransitionSec(tileLen(a), tileLen(b))
  if (max < TRANSITION_MIN_SEC - EPS) return { ok: false, reason: 'The clips are too short for a transition.' }
  // Meeting at a seam: the default length. Already overlapping: that overlap.
  const sec = overlap <= SEAM_GAP_SEC ? Math.min(TRANSITION_DEFAULT_SEC, max) : overlap
  if (sec > max + 1e-3) {
    return {
      ok: false,
      reason: `They overlap by more than the longest transition they can take (${max.toFixed(1)} s).`
    }
  }
  const len = ms(clampTransitionSec(sec, max))
  const slide = Math.max(0, ms(len - overlap))
  if (slide > EPS && roomBefore(c, movers(c, b, b.startSec)) < slide - 1e-3) {
    return { ok: false, reason: 'There is no room to slide the second clip in.' }
  }
  return { ok: true, outId: a.id, inId: b.id, sec: len, slide }
}

/** What slides when the incoming clip `b` moves: its group and every tile
 *  that starts at or after `fromSec` (`tilesFrom`). */
function movers(c: Composition, b: Layer, fromSec: number): TimelineItemRef[] {
  const group = groupOf(c, b.id)
  return [...group, ...tilesFrom(c, fromSec, group)]
}

/**
 * Where a pair's tiles "after the cut" begin: the incoming clip's ORIGINAL,
 * pre-overlap start — the end of the outgoing clip, which no resize moves
 * (only the incoming side slides), so it is the same point however often the
 * pair is resized. A tile that starts inside the overlap (before it) stays
 * with the outgoing clip.
 */
const cutOf = (c: Composition, pair: TransitionPair): number => c.layers.find((l) => l.id === pair.outId)!.endSec

/** `upperId` placed directly above `lowerId` in the stack when it is below it now. */
export function placeAbove<C extends Composition>(c: C, lowerId: string, upperId: string): C {
  const lo = c.layers.findIndex((l) => l.id === lowerId)
  const up = c.layers.findIndex((l) => l.id === upperId)
  if (lo < 0 || up < 0 || up > lo) return c
  // Lift the upper tile out, then put it back right after the lower one: the
  // lower one's slot becomes [lower, upper].
  const without = c.layers.filter((l) => l.id !== upperId)
  const at = without.findIndex((l) => l.id === lowerId)
  return { ...c, layers: replaceAt(without, at, 1, without[at], c.layers[up]) }
}

/** `c` with layer `id` replaced by `fn(layer)` (`updateById`). */
const mapLayer = <C extends Composition>(c: C, id: string, fn: (l: Layer) => Layer): C => ({
  ...c,
  layers: updateById(c.layers, id, fn)
})

/** Audio clip `a`'s timeline window through the shared timing (its source
 *  window played at its speed, holds included — shared/audioTiming.ts), or
 *  null when its source length is not known. */
function audioWindow(a: AudioClip, srcDur: SourceDuration): { startSec: number; endSec: number } | null {
  const dur = srcDur(a.mediaId)
  const out = dur > 0 ? effectiveOut(a, dur) : a.outSec
  if (!(out > a.inSec)) return null
  return { startSec: a.startSec, endSec: a.startSec + audioPlayedSec(a, out) }
}

/**
 * The fades a crossfade sets: in layer `id`'s link group, ONLY the audio clips
 * that meet the pair at the cut — clips of the picture's own source (its
 * extracted sound, same `mediaId`) whose timeline END is the layer's end
 * (`fadeOutSec`, the outgoing clip) or whose START is its start (`fadeInSec`,
 * the incoming clip), within a seam's gap. A linked sound effect or music, a
 * piece of the clip's sound that stops before the cut, and an image (no sound
 * of its own) get nothing. `field` goes to `sec`, held to each clip's own
 * length; `onlyIf` limits it to clips whose fade is still that value (a length
 * change carries along only untouched fades).
 */
function setCutFades<C extends Composition>(
  c: C,
  id: string,
  field: 'fadeInSec' | 'fadeOutSec',
  sec: number,
  srcDur: SourceDuration,
  onlyIf?: number
): C {
  const l = c.layers.find((x) => x.id === id)
  if (!l?.linkGroupId || l.content.kind !== 'video') return c
  const { linkGroupId: gid } = l
  const src = l.content.mediaId
  let changed = false
  const audioClips = c.audioClips.map((a): AudioClip => {
    if (a.linkGroupId !== gid || a.mediaId !== src) return a
    const w = audioWindow(a, srcDur)
    const meets =
      w !== null &&
      (field === 'fadeOutSec'
        ? Math.abs(w.endSec - l.endSec) <= SEAM_GAP_SEC
        : Math.abs(w.startSec - l.startSec) <= SEAM_GAP_SEC)
    if (!w || !meets) return a
    if (onlyIf !== undefined && Math.abs(a[field] - onlyIf) > 1e-3) return a
    changed = true
    return { ...a, [field]: ms(Math.min(sec, w.endSec - w.startSec)) }
  })
  return changed ? { ...c, audioClips } : c
}

/**
 * Apply a transition of `kind` (a pair kind) between the two clips `refs` pick:
 * slide the incoming one in, put it above the outgoing one, store both sides and
 * crossfade their linked sound. Returns `c` unchanged when the selection does
 * not qualify (`transitionCandidate` says why).
 */
export function applyTransition<C extends Composition>(
  c: C,
  refs: TimelineItemRef[],
  kind: TransitionKind,
  srcDur: SourceDuration = () => 0
): C {
  const check = transitionCandidate(c, refs)
  if (!check.ok || !TRANSITION_KINDS[kind].pair) return c
  const b = c.layers.find((l) => l.id === check.inId)!
  let next = check.slide > EPS ? shiftFrom(c, b.startSec, -check.slide, groupOf(c, b.id)) : c
  next = placeAbove(next, check.outId, check.inId)
  const tr: LayerTransition = { kind, sec: check.sec }
  next = mapLayer(next, check.outId, (l) => withTransition(l, 'out', tr))
  next = mapLayer(next, check.inId, (l) => withTransition(l, 'in', tr))
  next = setCutFades(next, check.outId, 'fadeOutSec', check.sec, srcDur)
  return setCutFades(next, check.inId, 'fadeInSec', check.sec, srcDur)
}

/**
 * The longest an edit may make a side: half its tile (and, in a pair, half the
 * shorter tile), and in a pair no longer than the room the incoming side has
 * to slide — but never below the side's CURRENT length. A transition a trim
 * left longer than that (owner decision 6: nothing is clamped; the Inspector
 * warns, `transitionOverrunSec`) can be kept or shortened from where it is;
 * its first edit never snaps it down to the usual maximum.
 */
export function maxSideSec(c: Composition, id: string, side: TransitionSide): number {
  const l = c.layers.find((x) => x.id === id)
  if (!l) return 0
  const current = transitionOf(l, side)?.sec ?? 0
  const pair = pairOf(c.layers, id, side)
  if (!pair) return Math.max(current, maxTransitionSec(tileLen(l)))
  const a = c.layers.find((x) => x.id === pair.outId)!
  const b = c.layers.find((x) => x.id === pair.inId)!
  const usual = Math.min(
    maxTransitionSec(tileLen(a), tileLen(b)),
    pair.sec + roomBefore(c, movers(c, b, cutOf(c, pair)))
  )
  return Math.max(current, usual)
}

/**
 * Change the length of layer `id`'s transition on `side`. A pair resizes
 * together: the incoming side slides by the change (so the overlap stays equal
 * to the length) and the crossfade follows. What slides is the incoming clip,
 * its link group and every tile that starts at or after the CUT (`cutOf`: the
 * outgoing clip's end, the incoming clip's pre-overlap start) — a tile that
 * starts inside the overlap, such as an unlinked caption over the outgoing
 * clip's last words, stays. A lone side (a fade) just changes. Held to
 * [0.1 s, `maxSideSec`].
 */
export function setTransitionLength<C extends Composition>(
  c: C,
  id: string,
  side: TransitionSide,
  sec: number,
  srcDur: SourceDuration = () => 0
): C {
  const l = c.layers.find((x) => x.id === id)
  const tr = l ? transitionOf(l, side) : null
  if (!l || !tr) return c
  const next = ms(clampTransitionSec(sec, maxSideSec(c, id, side)))
  const pair = pairOf(c.layers, id, side)
  if (!pair)
    return Math.abs(next - tr.sec) < EPS ? c : mapLayer(c, id, (x) => withTransition(x, side, { ...tr, sec: next }))
  const delta = next - pair.sec
  if (Math.abs(delta) < EPS) return c
  let out = shiftFrom(c, cutOf(c, pair), -delta, groupOf(c, pair.inId))
  if (out === c) return c // no room (maxSideSec should have prevented it)
  const resized: LayerTransition = { kind: pair.kind, sec: next }
  out = mapLayer(out, pair.outId, (x) => withTransition(x, 'out', resized))
  out = mapLayer(out, pair.inId, (x) => withTransition(x, 'in', resized))
  out = setCutFades(out, pair.outId, 'fadeOutSec', next, srcDur, pair.sec)
  return setCutFades(out, pair.inId, 'fadeInSec', next, srcDur, pair.sec)
}

/** Remove layer `id`'s transition on `side` — both sides of a pair. Nothing
 *  slides back: the overlap stays as a plain overlap, and the fades stay. */
export function removeTransition<C extends Composition>(c: C, id: string, side: TransitionSide): C {
  const pair = pairOf(c.layers, id, side)
  if (!pair) return mapLayer(c, id, (l) => withTransition(l, side, null))
  const out = mapLayer(c, pair.outId, (l) => withTransition(l, 'out', null))
  return mapLayer(out, pair.inId, (l) => withTransition(l, 'in', null))
}

/**
 * Change the kind of layer `id`'s transition on `side`. A pair switches between
 * the pair kinds together; choosing a plain fade on a pair's side breaks the
 * pair (its partner's side goes) and leaves this side a fade of the same length.
 */
export function setTransitionKind<C extends Composition>(
  c: C,
  id: string,
  side: TransitionSide,
  kind: TransitionKind
): C {
  const l = c.layers.find((x) => x.id === id)
  const tr = l ? transitionOf(l, side) : null
  if (!l || !tr || tr.kind === kind) return c
  const pair = pairOf(c.layers, id, side)
  if (pair && TRANSITION_KINDS[kind].pair) {
    const out = mapLayer(c, pair.outId, (x) => withTransition(x, 'out', { kind, sec: pair.sec }))
    return mapLayer(out, pair.inId, (x) => withTransition(x, 'in', { kind, sec: pair.sec }))
  }
  const cleared = pair ? removeTransition(c, id, side) : c
  return mapLayer(cleared, id, (x) => withTransition(x, side, { kind, sec: tr.sec }))
}

/**
 * A plain FADE at layer `id`'s `side` (a fade in from, or out to, whatever is
 * underneath): `sec` held to [0.1 s, `maxSideSec`: half the tile, or the
 * fade's current length when a trim left it longer]; 0 or less removes it. A
 * side that is part of a pair is left alone (change it through the pair).
 */
export function setFade<C extends Composition>(c: C, id: string, side: TransitionSide, sec: number): C {
  const l = c.layers.find((x) => x.id === id)
  if (!l || !takesTransitions(l) || pairOf(c.layers, id, side)) return c
  if (!(sec > 0)) return transitionOf(l, side) ? mapLayer(c, id, (x) => withTransition(x, side, null)) : c
  const s = ms(clampTransitionSec(sec, maxSideSec(c, id, side)))
  return mapLayer(c, id, (x) => withTransition(x, side, { kind: 'fade', sec: s }))
}

/** What `setSideTransition` did, for the assistant's answer. */
export interface SideTransitionResult<C extends Composition> {
  comp: C
  transition: LayerTransition | null
  partnerId: string | null
}

/**
 * ONE call that sets layer `id`'s transition on `side` to `kind` — the
 * assistant's `set_transition`, as a single edit:
 *
 * - `none` removes it (both sides of a pair; the overlap stays);
 * - `fade` makes it a plain fade (a pair's side breaks off its partner);
 * - a pair kind on a side that already has a partner switches the pair's kind;
 *   otherwise the clip is joined to its NEIGHBOUR on that side — the clip
 *   that ends where it starts (`in`) or starts where it ends (`out`), or
 *   already overlaps it there — exactly as Add transition does.
 *
 * `sec` (optional) is the length, held to the usual bounds. Throws a readable
 * error, changing nothing, when the layer can't take it.
 */
export function setSideTransition<C extends Composition>(
  c: C,
  id: string,
  side: TransitionSide,
  kind: TransitionKind | 'none',
  sec: number | undefined,
  srcDur: SourceDuration = () => 0
): SideTransitionResult<C> {
  const l = c.layers.find((x) => x.id === id)
  if (!l) throw new Error(`No layer with id ${id}`)
  if (!takesTransitions(l)) throw new Error('Only video and image clips take transitions.')
  let next: C = c
  if (kind === 'none') next = removeTransition(c, id, side)
  else if (kind === 'fade') {
    const tr = transitionOf(l, side)
    next = tr && tr.kind !== 'fade' ? setTransitionKind(c, id, side, 'fade') : c
    next = setFade(next, id, side, sec ?? tr?.sec ?? TRANSITION_DEFAULT_SEC)
  } else if (pairOf(c.layers, id, side)) {
    next = setTransitionKind(c, id, side, kind)
    if (sec !== undefined) next = setTransitionLength(next, id, side, sec, srcDur)
  } else {
    const other = neighbourOf(c, l, side)
    if (!other) {
      throw new Error(
        `No clip ${side === 'in' ? 'ends where this one starts' : 'starts where this one ends'}: a ${TRANSITION_KINDS[kind].label.toLowerCase()} joins two clips that meet.`
      )
    }
    const refs = [layerRef(id), layerRef(other.id)]
    const check = transitionCandidate(c, refs)
    if (!check.ok) throw new Error(check.reason)
    next = applyTransition(c, refs, kind, srcDur)
    if (sec !== undefined) next = setTransitionLength(next, id, side, sec, srcDur)
  }
  const after = next.layers.find((x) => x.id === id)!
  const pair = pairOf(next.layers, id, side)
  return {
    comp: next,
    transition: transitionOf(after, side),
    partnerId: pair ? (side === 'in' ? pair.outId : pair.inId) : null
  }
}

/** The video / image clip that meets `l` on `side` (ends where it starts, or
 *  starts where it ends — or overlaps it there), the nearest one. */
function neighbourOf(c: Composition, l: Layer, side: TransitionSide): Layer | null {
  let best: { l: Layer; d: number } | null = null
  for (const o of c.layers) {
    if (o.id === l.id || !takesTransitions(o)) continue
    const d = side === 'in' ? Math.abs(o.endSec - l.startSec) : Math.abs(l.endSec - o.startSec)
    const meets = d <= SEAM_GAP_SEC
    const overlaps =
      side === 'in'
        ? o.startSec < l.startSec && o.endSec > l.startSec && o.endSec < l.endSec
        : l.startSec < o.startSec && l.endSec > o.startSec && l.endSec < o.endSec
    if ((meets || overlaps) && (!best || d < best.d)) best = { l: o, d }
  }
  return best?.l ?? null
}
