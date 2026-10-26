/**
 * Small pure timeline utilities. Most layer math now lives in `@shared/layers`
 * (shared with the exporter); this file keeps the renderer-only bits: generic
 * array reorder and split operations for video layers / audio clips. Kept
 * dependency-free so it can be unit-tested.
 */

import type { AudioClip, CaptionSegment, FreezeHold, Layer, LayerKeyframe, VideoContent } from '@shared/project'
import { audioClipEnd, effectiveOut } from '@shared/project'
import { layerTransformAt } from '@shared/layers'
import { extractedAudioClip } from '@shared/volumeLevels'
import { playedBetween, sourceAfterPlayed } from '@shared/speed'
import { clamp } from '@shared/math'
import { shiftMarks } from '@shared/graphics'
import { splitWorkout, trimWorkoutEnd, trimWorkoutStart } from '@shared/workoutOverlay'

/** Cut tolerance shared by every split below (and mirrored by
 *  `splittableAt` in `lib/links.ts`, which decides whether to offer the cut). */
const EPS = 1e-3

/** Shortest window a trim may leave behind, per tile kind (seconds). These are
 *  the guards the timeline's edge drags have always applied; they live here now
 *  so the group trim clamps identically. */
const MIN_LAYER_SEC = 0.2
const MIN_CAPTION_SEC = 0.1
const MIN_SOURCE_SEC = 0.1

/** Which end of a tile an edge drag moves. */
export type TrimEdge = 'start' | 'end'

/**
 * A trimmed tile plus the TIMELINE delta its edge actually moved — a trim can be
 * cut short by the source running out or by the minimum window. Group trims use
 * `achieved` to find the one delta every member can absorb, which is what keeps a
 * linked pair in step (see `trimItemsBy` in `lib/links.ts`).
 */
export interface Trimmed<T> {
  tile: T
  achieved: number
}

/**
 * Partition a layer's keyframes across a cut at absolute time `atSec`, returning
 * `[left, right]` lists (`undefined` when the layer has none).
 *
 * Two things have to happen or the motion breaks at the seam: keyframe `tSec` is
 * relative to `startSec`, so the right half's are re-based; and BOTH halves get a
 * keyframe exactly at the cut carrying the interpolated transform — without it
 * each half would hold its own first/last keyframe flat and the layer would jump
 * where the two pieces meet.
 */
function splitLayerKeyframes(layer: Layer, atSec: number): [LayerKeyframe[] | undefined, LayerKeyframe[] | undefined] {
  const kfs = layer.keyframes
  if (!kfs || kfs.length === 0) return [undefined, undefined]
  const cut = atSec - layer.startSec
  const at = layerTransformAt(layer, atSec)
  // Full opacity is stored as ABSENCE (like `addLayerKeyframe`), so an untouched
  // layer keeps the plain, no-alpha export path.
  const seam = (tSec: number): LayerKeyframe => ({
    tSec,
    x: at.x,
    y: at.y,
    scale: at.scale,
    ...(at.opacity < 0.9995 ? { opacity: at.opacity } : {})
  })
  return [
    [...kfs.filter((k) => k.tSec < cut - EPS), seam(cut)],
    [seam(0), ...kfs.filter((k) => k.tSec > cut + EPS).map((k) => ({ ...k, tSec: k.tSec - cut }))]
  ]
}

/** Move the item at `from` to index `to`, returning a new array. */
export function reorder<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return items
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Split a video layer at an absolute timeline time `atSec` into [left, right]
 * sharing the same source, or null if the cut falls at/outside the layer's span.
 *
 * Freeze holds (and the clip's speed profile — constant `speed` or a keyframed
 * `speedRamp`) make the timeline→source mapping NONLINEAR, so the cut's source
 * point is found by walking the holds (mirroring `videoSourceTime`) and the
 * freezes are partitioned between the halves — a hold the cut lands inside is
 * itself split, so both halves keep the invariant
 * `window = playedBetween(inSec, outSec) + Σ holds`. The ramp keyframes are
 * source-anchored, so both halves keep the full ramp list unchanged; transform
 * keyframes are start-relative and get partitioned (`splitLayerKeyframes`).
 */
export function splitVideoLayer(layer: Layer, atSec: number, makeId: () => string): [Layer, Layer] | null {
  if (layer.content.kind !== 'video') return null
  const eps = EPS
  if (atSec <= layer.startSec + eps || atSec >= layer.endSec - eps) return null
  const [leftKfs, rightKfs] = splitLayerKeyframes(layer, atSec)
  const c = layer.content as VideoContent
  const freezes = [...(c.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)

  const cutLocal = atSec - layer.startSec // cut position in played time
  const leftFreezes: FreezeHold[] = []
  const rightFreezes: FreezeHold[] = []
  let holdBefore = 0 // played time consumed by holds fully before the cut
  let cutSource: number | null = null
  for (const f of freezes) {
    const atPlayed = playedBetween(c, c.inSec, f.atSec) + holdBefore // hold start, in played time
    if (cutSource != null || cutLocal <= atPlayed + eps) {
      rightFreezes.push(f) // hold is entirely after the cut
    } else if (cutLocal < atPlayed + f.holdSec) {
      // Cut lands inside this hold: split its duration across the halves.
      const leftPart = cutLocal - atPlayed
      const rightPart = f.holdSec - leftPart
      if (leftPart > eps) leftFreezes.push({ atSec: f.atSec, holdSec: leftPart })
      if (rightPart > eps) rightFreezes.push({ atSec: f.atSec, holdSec: rightPart })
      cutSource = f.atSec // the held frame is the cut frame
    } else {
      leftFreezes.push(f)
      holdBefore += f.holdSec
    }
  }
  if (cutSource == null) cutSource = sourceAfterPlayed(c, c.inSec, cutLocal - holdBefore, c.outSec)

  const left: Layer = {
    ...layer,
    endSec: atSec,
    keyframes: leftKfs,
    content: { ...c, outSec: cutSource, freezes: leftFreezes.length ? leftFreezes : undefined }
  }
  const right: Layer = {
    ...layer,
    id: makeId(),
    startSec: atSec,
    keyframes: rightKfs,
    content: { ...c, inSec: cutSource, freezes: rightFreezes.length ? rightFreezes : undefined }
  }
  return [left, right]
}

/**
 * Split a WORKOUT overlay at absolute timeline time `atSec` into two tiles over
 * consecutive ride windows at the same speed (`splitWorkout`, shared/
 * workoutOverlay.ts). Null when the cut misses it or it isn't a workout.
 */
export function splitWorkoutLayer(layer: Layer, atSec: number, makeId: () => string): [Layer, Layer] | null {
  return layer.content.kind === 'workout' ? splitWorkout(layer, layer.content, atSec, makeId) : null
}

/**
 * Split a TEXT, IMAGE or GRAPHICS layer at absolute timeline time `atSec` into
 * [left, right], or null if the cut falls at/outside its span (or the layer is a
 * video/layout — those go through `splitVideoLayer`, or aren't splittable).
 *
 * There's no source trim to divide: the halves are the same content over adjacent
 * windows. What does get partitioned is anything anchored to the layer's window,
 * so the seam stays invisible:
 *
 * - transform keyframes, via `splitLayerKeyframes`;
 * - a text entrance/exit animation — the left half keeps the ENTRANCE and the
 *   right half keeps the EXIT (copying both onto both halves would replay the
 *   animation mid-block). `wordHighlight` is the exception: it spans the whole
 *   window rather than being an entrance, so both halves keep it;
 * - graphics marks (start-relative `atSec`): the left half keeps those that
 *   appear before the cut, the right half all of them re-based to its start
 *   (`shiftMarks` — one already on screen keeps its moment as a negative
 *   `atSec`, so it carries on mid-reveal and a later re-join restores it).
 */
export function splitStaticLayer(layer: Layer, atSec: number, makeId: () => string): [Layer, Layer] | null {
  const kind = layer.content.kind
  if (kind !== 'text' && kind !== 'image' && kind !== 'graphics') return null
  if (atSec <= layer.startSec + EPS || atSec >= layer.endSec - EPS) return null
  const [leftKfs, rightKfs] = splitLayerKeyframes(layer, atSec)
  const left: Layer = { ...layer, endSec: atSec, keyframes: leftKfs }
  const right: Layer = { ...layer, id: makeId(), startSec: atSec, keyframes: rightKfs }
  if (layer.content.kind === 'graphics') {
    const cut = atSec - layer.startSec
    const marks = layer.content.marks
    left.content = { ...layer.content, marks: marks.filter((m) => m.atSec < cut) }
    // Fresh ids: the two halves are separate tiles with their own marks.
    right.content = { ...layer.content, marks: shiftMarks(marks, cut).map((m) => ({ ...m, id: makeId() })) }
  }
  const anim = layer.content.kind === 'text' ? layer.content.animation : null
  if (layer.content.kind === 'text' && anim) {
    const spansWindow = anim.in === 'wordHighlight'
    left.content = { ...layer.content, animation: { ...anim, out: 'none' } }
    right.content = {
      ...layer.content,
      animation: { ...anim, ...(spansWindow ? {} : { in: 'none' }) }
    }
  }
  return [left, right]
}

/**
 * Split a caption segment at `atSec` into [left, right], or null if the cut falls
 * at/outside its span. Word timings are absolute, so each half keeps the words on
 * its side of the cut (a word straddling it goes to the side holding more of it)
 * and its `text` is rebuilt from them the same way `buildCaptions` joins words. A
 * segment with no word timings keeps the full text on both halves — the words are
 * what carry the split, and there's nothing better to guess.
 */
export function splitCaptionSegment(
  seg: CaptionSegment,
  atSec: number,
  makeId: () => string
): [CaptionSegment, CaptionSegment] | null {
  if (atSec <= seg.startSec + EPS || atSec >= seg.endSec - EPS) return null
  const words = seg.words ?? []
  const onLeft = (w: { startSec: number; endSec: number }): boolean => (w.startSec + w.endSec) / 2 < atSec
  const leftWords = words.filter(onLeft)
  const rightWords = words.filter((w) => !onLeft(w))
  const textOf = (ws: typeof words): string => (ws.length ? ws.map((w) => w.text).join(' ') : seg.text)
  return [
    { ...seg, endSec: atSec, words: leftWords, text: textOf(leftWords) },
    { ...seg, id: makeId(), startSec: atSec, words: rightWords, text: textOf(rightWords) }
  ]
}

/**
 * Trim a video layer's LEFT edge to source in-point `ni` (caller clamps `ni` to
 * `[0, outSec)`). Holds before the new in-point are dropped and the start shifts
 * by the trimmed source time PLUS the dropped hold time, keeping `endSec` fixed
 * and the window invariant intact. Computed from the drag-start snapshot, so
 * dragging back left restores previously dropped holds.
 */
export function trimVideoStart(layer: Layer, c: VideoContent, ni: number): Layer {
  const freezes = c.freezes ?? []
  const kept = freezes.filter((f) => f.atSec >= ni)
  const dropped = freezes.reduce((s, f) => s + (f.atSec < ni ? Math.max(0, f.holdSec) : 0), 0)
  const startSec = Math.max(0, layer.startSec + playedBetween(c, c.inSec, ni) + dropped)
  return { ...layer, startSec, content: { ...c, inSec: ni, freezes: kept.length ? kept : undefined } }
}

/**
 * Trim the RIGHT edge to source out-point `no` (caller clamps to `(inSec, src]`).
 * Holds past the new out-point are dropped; the new end keeps the remaining
 * holds' time — recomputing `endSec` without them silently cut the hold time
 * out of a frozen clip (the pre-helper inline math did exactly that).
 */
export function trimVideoEnd(layer: Layer, c: VideoContent, no: number): Layer {
  const freezes = c.freezes ?? []
  const kept = freezes.filter((f) => f.atSec <= no)
  const keptHold = kept.reduce((s, f) => s + Math.max(0, f.holdSec), 0)
  const endSec = layer.startSec + playedBetween(c, c.inSec, no) + keptHold
  return { ...layer, endSec, content: { ...c, outSec: no, freezes: kept.length ? kept : undefined } }
}

/**
 * Trim the RIGHT edge by a TIMELINE delta (negative = shorter), walking back
 * through the clip as it plays: the footage after the last freeze, then that
 * freeze's hold, then the footage before it, and so on. So dragging the edge
 * into a freeze cuts everything past it and then shortens the hold (a hold used
 * up, or cut under EPS, is dropped) — continuous in the delta to within EPS,
 * which a group trim relies on. Lengthening extends the footage, up to source
 * second `maxSrc`. At least MIN_SOURCE_SEC of source always stays.
 */
export function trimVideoEndBy(layer: Layer, c: VideoContent, deltaSec: number, maxSrc: number): Layer {
  const minSrc = c.inSec + MIN_SOURCE_SEC
  if (deltaSec >= 0) return trimVideoEnd(layer, c, clamp(sourceAfterPlayed(c, c.outSec, deltaSec), minSrc, maxSrc))
  if (c.outSec < minSrc) return layer
  const kept = (c.freezes ?? []).filter((f) => f.atSec <= c.outSec).sort((a, b) => a.atSec - b.atSec)
  let out = c.outSec
  let left = -deltaSec
  // Stop as soon as the delta is used up: walking on with `left` at 0 would
  // hand `sourceAfterPlayed` a -0, which it reads as FORWARD (clamped to the
  // floor) and collapses the clip to its minimum.
  while (left > 0) {
    const last = kept[kept.length - 1]
    // A hold before the minimum source span can't be reached: it stays.
    const reachable = !!last && last.atSec >= minSrc
    const floor = reachable ? last.atSec : minSrc
    const footage = Math.max(0, playedBetween(c, floor, out))
    if (left <= footage) {
      out = Math.max(floor, sourceAfterPlayed(c, out, -left, floor))
      break
    }
    left -= footage
    out = floor
    if (!reachable) break
    if (left < last.holdSec - EPS) {
      kept[kept.length - 1] = { ...last, holdSec: last.holdSec - left }
      break
    }
    left -= Math.max(0, last.holdSec)
    kept.pop()
  }
  return trimVideoEnd(layer, { ...c, freezes: kept }, out)
}

/** Shortest hold a freeze overlay drag leaves (removing one is Delete's job). */
export const MIN_HOLD_SEC = 0.1

/** Set the hold of the freeze at `index` (in `c.freezes`), clamped to
 *  MIN_HOLD_SEC. Only this clip's end moves, by the change in hold. */
export function setFreezeHold(layer: Layer, c: VideoContent, index: number, holdSec: number): Layer {
  const f = c.freezes?.[index]
  if (!f) return layer
  const hold = Math.max(MIN_HOLD_SEC, holdSec)
  const freezes = (c.freezes ?? []).map((g, i) => (i === index ? { ...g, holdSec: hold } : g))
  return { ...layer, endSec: layer.endSec + hold - Math.max(0, f.holdSec), content: { ...c, freezes } }
}

/**
 * Trim one LAYER's `edge` by `deltaSec` timeline seconds, clamped to what the
 * layer can actually give: a video is bounded by its source (`srcDurSec`, or its
 * own out-point when the duration isn't known yet), text/image by a minimum
 * window. `startSec`/`endSec` moves; the opposite edge stays put.
 *
 * The delta is TIMELINE (played) time for every kind — a video converts it
 * through its own speed profile and freeze holds (`sourceAfterPlayed` +
 * `trimVideoStart`, and `trimVideoEndBy`), so a group trim can hand every member the
 * same number and each honors its own mapping. That's the whole reason this is
 * one function per kind with a shared signature.
 */
export function trimLayerEdge(layer: Layer, edge: TrimEdge, deltaSec: number, srcDurSec = 0): Trimmed<Layer> {
  const c = layer.content
  let tile = layer
  if (c.kind === 'workout') {
    // The ride window follows the edge at the tile's speed (shared mapping).
    tile = edge === 'start' ? trimWorkoutStart(layer, c, deltaSec) : trimWorkoutEnd(layer, c, deltaSec, srcDurSec)
  } else if (c.kind === 'video') {
    const maxSrc = srcDurSec > 0 ? srcDurSec : c.outSec
    tile =
      edge === 'start'
        ? trimVideoStart(layer, c, clamp(sourceAfterPlayed(c, c.inSec, deltaSec), 0, c.outSec - MIN_SOURCE_SEC))
        : trimVideoEndBy(layer, c, deltaSec, maxSrc)
  } else if (edge === 'start') {
    tile = { ...layer, startSec: clamp(layer.startSec + deltaSec, 0, layer.endSec - MIN_LAYER_SEC) }
    // Graphics marks are timed from the start: re-base them so each keeps its
    // moment on the clip underneath instead of riding the edge.
    if (c.kind === 'graphics') {
      tile.content = { ...c, marks: shiftMarks(c.marks, tile.startSec - layer.startSec) }
    }
  } else {
    tile = { ...layer, endSec: Math.max(layer.startSec + MIN_LAYER_SEC, layer.endSec + deltaSec) }
  }
  const achieved = edge === 'start' ? tile.startSec - layer.startSec : tile.endSec - layer.endSec
  return { tile, achieved }
}

/** Trim a caption segment's `edge` by `deltaSec`, keeping a minimum window.
 *  Word timings are left alone — they're absolute, and a trimmed caption simply
 *  shows fewer of them. */
export function trimCaptionEdge(seg: CaptionSegment, edge: TrimEdge, deltaSec: number): Trimmed<CaptionSegment> {
  const tile: CaptionSegment =
    edge === 'start'
      ? { ...seg, startSec: clamp(seg.startSec + deltaSec, 0, seg.endSec - MIN_CAPTION_SEC) }
      : { ...seg, endSec: Math.max(seg.startSec + MIN_CAPTION_SEC, seg.endSec + deltaSec) }
  return { tile, achieved: edge === 'start' ? tile.startSec - seg.startSec : tile.endSec - seg.endSec }
}

/**
 * Trim an audio clip's `edge` by `deltaSec`. The LEFT edge moves the in-point and
 * the clip's start together (the audio behind it doesn't slide); the RIGHT edge
 * moves the out-point, bounded by the source duration (`srcDurSec`, falling back
 * to the clip's own out-point the way the timeline's edge drag does).
 */
export function trimAudioEdge(clip: AudioClip, edge: TrimEdge, deltaSec: number, srcDurSec = 0): Trimmed<AudioClip> {
  const maxOut = srcDurSec > 0 ? srcDurSec : clip.outSec > 0 ? clip.outSec : 1
  const effOut = effectiveOut(clip, maxOut)
  if (edge === 'start') {
    const ni = clamp(clip.inSec + deltaSec, 0, effOut - MIN_SOURCE_SEC)
    const tile = { ...clip, inSec: ni, startSec: Math.max(0, clip.startSec + (ni - clip.inSec)) }
    return { tile, achieved: tile.startSec - clip.startSec }
  }
  const no = clamp(effOut + deltaSec, clip.inSec + MIN_SOURCE_SEC, maxOut)
  return { tile: { ...clip, outSec: no }, achieved: no - effOut }
}

/**
 * Build the extracted-audio clip(s) for a video layer, honoring its freeze holds:
 * the audio is split at each freeze's source point and the later pieces are pushed
 * back by the accumulated hold time, so the freeze windows fall silent (the dialogue
 * cuts while the frame is held) and the audio stays in sync with the stretched video.
 * With no freezes this is a single straight clip.
 */
export function extractAudioPieces(
  layer: Layer,
  content: VideoContent,
  makeId: () => string,
  /** Settings ▸ auto-join: the pieces land in the Default volume level. */
  autoJoinLevel: boolean
): AudioClip[] {
  // `extractedAudioClip` is the one constructor for audio pulled off footage
  // (and where auto-join is decided) — shared with the drop and the assistant.
  const base = (from: number, to: number, holdBefore: number): AudioClip =>
    extractedAudioClip(
      {
        id: makeId(),
        mediaId: content.mediaId,
        startSec: layer.startSec + (from - content.inSec) + holdBefore,
        inSec: from,
        outSec: to
      },
      autoJoinLevel
    )
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  const pieces: AudioClip[] = []
  let segStart = content.inSec
  let holdAcc = 0
  for (const f of freezes) {
    const at = Math.min(content.outSec, Math.max(content.inSec, f.atSec))
    if (at - segStart >= 0.02) pieces.push(base(segStart, at, holdAcc)) // skip slivers
    segStart = at
    holdAcc += Math.max(0, f.holdSec)
  }
  if (content.outSec - segStart >= 0.02) pieces.push(base(segStart, content.outSec, holdAcc))
  // Degenerate guard (e.g. all slivers): fall back to one straight clip.
  return pieces.length ? pieces : [base(content.inSec, content.outSec, 0)]
}

/**
 * Split an audio clip at a timeline time (seconds from 0). Returns [left, right]
 * sharing the same source, or null if the cut falls at/outside the clip's span.
 * The left piece keeps the original fade-in and drops its fade-out; the right
 * piece keeps the fade-out and drops its fade-in (the new seam is hard). For
 * whole-source clips (outSec<=0) `sourceDurationSec` resolves where they end;
 * pass <=0 when unknown (only the lower edge is then guarded).
 */
/** The TIMELINE second at which an audio clip plays source second `sourceSec`
 *  (audio has no speed or holds: a straight offset). */
export function audioTimelineAt(clip: Pick<AudioClip, 'startSec' | 'inSec'>, sourceSec: number): number {
  return clip.startSec + (sourceSec - clip.inSec)
}

export function splitAudioClip(
  clip: AudioClip,
  atSec: number,
  sourceDurationSec: number,
  makeId: () => string
): [AudioClip, AudioClip] | null {
  const end =
    clip.outSec > 0
      ? clip.startSec + (clip.outSec - clip.inSec)
      : sourceDurationSec > 0
        ? audioClipEnd(clip, sourceDurationSec)
        : Infinity
  if (atSec <= clip.startSec + EPS || atSec >= end - EPS) return null
  const cutSource = clip.inSec + (atSec - clip.startSec)
  const left: AudioClip = { ...clip, outSec: cutSource, fadeOutSec: 0 }
  const right: AudioClip = { ...clip, id: makeId(), inSec: cutSource, startSec: atSec, fadeInSec: 0 }
  return [left, right]
}
