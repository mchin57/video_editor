/**
 * Lay library clips end-to-end as ONE edit — the assistant's rough-cut
 * primitive (`place_sequence`). Pure. Layers come from the shared constructor
 * and are trimmed through `trimVideoStart`/`trimVideoEnd`, so the
 * source↔timeline mapping is never re-derived here (CLAUDE.md).
 */

import type { AudioClip, Composition, Layer, VideoContent } from '@shared/project'
import type { FrameRect } from '@shared/frame'
import type { PlacedClip, SequencePlan } from '@shared/assistant/protocol'
import { makeVideoLayer, visualDuration } from '@shared/layers'
import { compositionDuration } from '@shared/compositions'
import { MAX_TEXT_PAST_END_SEC, maxItemEndSec } from '@shared/assistant/onScreenText'
import { extractedAudioClip } from '@shared/volumeLevels'
import { trimVideoEnd, trimVideoStart } from './timeline'
import { expandSelection, removeItems } from './links'

/** Shortest source span an item may keep (seconds). */
export const MIN_SEQUENCE_ITEM_SEC = 0.1
/** How far an outSec may run past its source and still just clamp (rounding). */
export const MAX_SOURCE_OVERSHOOT_SEC = 0.5

export interface SequenceCtx {
  frame: FrameRect
  newId: () => string
  /** Settings ▸ auto-join: the extracted audio lands in the Default volume level. */
  autoJoinLevel: boolean
}

/** The audio a video drop pulls off its source, linked to the clip. One
 *  definition, shared with `addVideoLayer`; built by `extractedAudioClip`,
 *  which is where auto-join is decided (shared/volumeLevels.ts). */
export function makeExtractedAudioClip(
  id: string,
  mediaId: string,
  startSec: number,
  inSec: number,
  outSec: number,
  linkGroupId: string,
  autoJoinLevel: boolean
): AudioClip {
  return extractedAudioClip({ id, mediaId, startSec, inSec, outSec, linkGroupId }, autoJoinLevel)
}

/**
 * Where in the back→front `base.layers` the new clips go. Added clips land on
 * the top layer, like a drag from the library; only a `replace` that removed
 * video puts them back in its place — the slot of the bottom-most removed
 * video, so layers that were above it stay above the new clips.
 */
function sequenceInsertIndex(before: Layer[], base: Layer[]): number {
  const kept = new Set(base.map((l) => l.id))
  const firstRemovedVideo = before.findIndex((l) => l.content.kind === 'video' && !kept.has(l.id))
  if (firstRemovedVideo >= 0) return before.slice(0, firstRemovedVideo).filter((l) => kept.has(l.id)).length
  return base.length
}

export function applySequence(
  comp: Composition,
  plan: SequencePlan,
  ctx: SequenceCtx
): { comp: Composition; placed: PlacedClip[] } {
  const base =
    plan.mode === 'replace'
      ? removeItems(
          comp,
          expandSelection(
            comp,
            comp.layers.filter((l) => l.content.kind === 'video').map((l) => ({ kind: 'layer' as const, id: l.id }))
          )
        )
      : comp
  // Same bound as set_text: an atSec far past the end is a ms-for-seconds slip
  // (or worse — 1e9 made the export encode ~31 years of black).
  const editEnd = compositionDuration(base)
  if (plan.atSec !== undefined && plan.atSec > maxItemEndSec(editEnd)) {
    throw new Error(
      `atSec ${plan.atSec} is more than ${MAX_TEXT_PAST_END_SEC}s past the end of the edit (${Math.round(editEnd * 100) / 100}s); times are in seconds`
    )
  }
  let cursor = Math.max(0, plan.atSec ?? (plan.mode === 'replace' ? 0 : visualDuration(base.layers)))
  const layers: Layer[] = []
  const audioClips: AudioClip[] = []
  const placed: PlacedClip[] = []

  plan.items.forEach((item, i) => {
    const src = item.sourceDurationSec
    // A rounding overshoot clamps to the clip end; more is a wrong window
    // (often milliseconds for seconds), so say so instead of silently clamping.
    if (item.outSec > src + MAX_SOURCE_OVERSHOOT_SEC) {
      throw new Error(
        `item ${i} (${item.mediaId}): outSec ${item.outSec} is past the end of the ${src.toFixed(2)}s source; times are in seconds`
      )
    }
    const inSec = Math.min(Math.max(0, item.inSec), src)
    const outSec = Math.min(Math.max(0, item.outSec), src)
    if (outSec - inSec < MIN_SEQUENCE_ITEM_SEC) {
      throw new Error(
        `item ${i} (${item.mediaId}): ${item.inSec}–${item.outSec}s leaves less than ${MIN_SEQUENCE_ITEM_SEC}s of a ${src.toFixed(2)}s source`
      )
    }
    const id = ctx.newId()
    const full = makeVideoLayer(id, item.mediaId, 0, src, {
      mute: item.hasAudio,
      frame: ctx.frame,
      aspect: item.aspect
    })
    const tail = trimVideoEnd(full, full.content as VideoContent, outSec)
    const trimmed = trimVideoStart(tail, tail.content as VideoContent, inSec)
    // The trims leave the window where the source sits; slide it to the cursor.
    const shift = cursor - trimmed.startSec
    let layer: Layer = { ...trimmed, startSec: trimmed.startSec + shift, endSec: trimmed.endSec + shift }
    if (item.hasAudio) {
      const group = ctx.newId()
      layer = { ...layer, linkGroupId: group }
      audioClips.push(
        makeExtractedAudioClip(ctx.newId(), item.mediaId, layer.startSec, inSec, outSec, group, ctx.autoJoinLevel)
      )
    }
    layers.push(layer)
    placed.push({ layerId: id, mediaId: item.mediaId, inSec, outSec, startSec: layer.startSec, endSec: layer.endSec })
    cursor = layer.endSec
  })

  const at = sequenceInsertIndex(comp.layers, base.layers)
  return {
    comp: {
      ...base,
      layers: [...base.layers.slice(0, at), ...layers, ...base.layers.slice(at)],
      audioClips: [...base.audioClips, ...audioClips]
    },
    placed
  }
}
