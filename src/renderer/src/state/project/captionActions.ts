/** Project store slice: the CAPTION lane of the active composition — segments
 *  and their styles. */

import type { CaptionSegment, CaptionsConfig, CaptionStyle } from '@shared/project'
import * as links from '@/lib/links'
import { captionWithText } from '@/lib/captions'
import { updateById } from '@/lib/arrays'
import type { Doc } from './core'

export interface CaptionActions {
  setCaptions: (captions: CaptionsConfig) => void
  /** Patch one segment. New text without new words re-times the words to it. */
  updateCaption: (id: string, patch: Partial<CaptionSegment>) => void
  removeCaption: (id: string) => void
  /** Add a caption segment (＋ Caption), kept in start order, and turn the
   *  caption lane on so it shows. One undo step. */
  addCaption: (seg: CaptionSegment) => void
  /** Patch the lane-wide caption style (applies to every non-overridden segment). */
  setCaptionStyle: (patch: Partial<CaptionStyle>) => void
  /** Patch one segment's style override (seeded from the effective style), exempting
   *  it from the lane-wide style. */
  setCaptionSegmentStyle: (id: string, patch: Partial<CaptionStyle>) => void
  /** Drop a segment's override so it follows the lane-wide style again. */
  clearCaptionSegmentStyle: (id: string) => void
}

export const captionActions = ({ commitComp }: Doc): CaptionActions => {
  /** Rewrite every segment `id` of the active comp's caption lane. */
  const mapSegment = (id: string, fn: (s: CaptionSegment, captions: CaptionsConfig) => CaptionSegment): void =>
    commitComp((p) => ({
      ...p,
      captions: { ...p.captions, segments: updateById(p.captions.segments, id, (s) => fn(s, p.captions)) }
    }))

  return {
    setCaptions: (captions) => commitComp((p) => ({ ...p, captions })),

    // New text without new words re-times them (captionWithText): a split
    // rebuilds text FROM the words, so stale words would revert the edit.
    updateCaption: (id, patch) =>
      mapSegment(id, (s) =>
        patch.text !== undefined && patch.words === undefined
          ? { ...s, ...patch, words: captionWithText(s, patch.text).words }
          : { ...s, ...patch }
      ),

    removeCaption: (id) => commitComp((p) => links.removeItems(p, [{ kind: 'caption', id }])),

    addCaption: (seg) =>
      commitComp((p) => ({
        ...p,
        captions: {
          ...p.captions,
          enabled: true,
          segments: [...p.captions.segments, seg].sort((a, b) => a.startSec - b.startSec)
        }
      })),

    setCaptionStyle: (patch) =>
      commitComp((p) => ({ ...p, captions: { ...p.captions, style: { ...p.captions.style, ...patch } } })),

    setCaptionSegmentStyle: (id, patch) =>
      mapSegment(id, (s, captions) => ({ ...s, style: { ...(s.style ?? captions.style), ...patch } })),

    clearCaptionSegmentStyle: (id) => mapSegment(id, (s) => ({ ...s, style: null }))
  }
}
