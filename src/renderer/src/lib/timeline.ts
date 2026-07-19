/**
 * Small pure timeline utilities. Most layer math now lives in `@shared/layers`
 * (shared with the exporter); this file keeps the renderer-only bits: generic
 * array reorder and split operations for video layers / audio clips. Kept
 * dependency-free so it can be unit-tested.
 */

import type { AudioClip, FreezeHold, Layer, VideoContent } from '@shared/project'
import { audioClipEnd } from '@shared/project'
import { playedBetween, sourceAfterPlayed } from '@shared/speed'

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
 * source-anchored, so both halves keep the full ramp list unchanged.
 */
export function splitVideoLayer(
  layer: Layer,
  atSec: number,
  makeId: () => string
): [Layer, Layer] | null {
  if (layer.content.kind !== 'video') return null
  const eps = 1e-3
  if (atSec <= layer.startSec + eps || atSec >= layer.endSec - eps) return null
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
    content: { ...c, outSec: cutSource, freezes: leftFreezes.length ? leftFreezes : undefined }
  }
  const right: Layer = {
    ...layer,
    id: makeId(),
    startSec: atSec,
    content: { ...c, inSec: cutSource, freezes: rightFreezes.length ? rightFreezes : undefined }
  }
  return [left, right]
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
 * Build the extracted-audio clip(s) for a video layer, honoring its freeze holds:
 * the audio is split at each freeze's source point and the later pieces are pushed
 * back by the accumulated hold time, so the freeze windows fall silent (the dialogue
 * cuts while the frame is held) and the audio stays in sync with the stretched video.
 * With no freezes this is a single straight clip.
 */
export function extractAudioPieces(
  layer: Layer,
  content: VideoContent,
  makeId: () => string
): AudioClip[] {
  const base = (from: number, to: number, holdBefore: number): AudioClip => ({
    id: makeId(),
    mediaId: content.mediaId,
    startSec: layer.startSec + (from - content.inSec) + holdBefore,
    inSec: from,
    outSec: to,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    kind: 'extracted'
  })
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
  const eps = 1e-3
  if (atSec <= clip.startSec + eps || atSec >= end - eps) return null
  const cutSource = clip.inSec + (atSec - clip.startSec)
  const left: AudioClip = { ...clip, outSec: cutSource, fadeOutSec: 0 }
  const right: AudioClip = { ...clip, id: makeId(), inSec: cutSource, startSec: atSec, fadeInSec: 0 }
  return [left, right]
}
