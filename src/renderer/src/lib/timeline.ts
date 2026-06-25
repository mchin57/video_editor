/**
 * Small pure timeline utilities. Most layer math now lives in `@shared/layers`
 * (shared with the exporter); this file keeps the renderer-only bits: generic
 * array reorder and split operations for video layers / audio clips. Kept
 * dependency-free so it can be unit-tested.
 */

import type { AudioClip, Layer, VideoContent } from '@shared/project'
import { audioClipEnd } from '@shared/project'

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
  const cutSource = c.inSec + (atSec - layer.startSec)
  const left: Layer = {
    ...layer,
    endSec: atSec,
    content: { ...c, outSec: cutSource }
  }
  const right: Layer = {
    ...layer,
    id: makeId(),
    startSec: atSec,
    content: { ...c, inSec: cutSource }
  }
  return [left, right]
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
