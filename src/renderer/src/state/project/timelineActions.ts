/** Project store slice: operations on "whatever tiles the user picked" — link
 *  groups, delete, mute, move, snap, split — across the three lanes, all
 *  through `lib/links.ts` (docs/SHARED.md "LINK GROUPS"). */

import type { TimelineItemRef } from '@shared/project'
import type { ReelTemplate } from '@shared/templates'
import { resolveCompAtPath } from '@shared/compositions'
import { newId } from '@shared/ids'
import * as links from '@/lib/links'
import { applyTemplate, type DropMedia } from '@/lib/templates'
import { primaryRef, useUi } from '@/state/ui'
import { activeComp, type Doc } from './core'

export interface TimelineActions {
  /** Link every (linkable) tile in `refs` into one group, merging the groups
   *  they already belong to. Layout layers are never linked. */
  linkItems: (refs: TimelineItemRef[]) => void
  /** Break every link group represented in `refs`, member tiles included. */
  unlinkItems: (refs: TimelineItemRef[]) => void
  /** Delete every tile in `refs` (any lane) as one undo step. */
  removeItems: (refs: TimelineItemRef[]) => void
  /** Toggle mute on every audio clip / video layer in `refs` as one undo step
   *  (the M key; a mixed selection mutes all first). */
  toggleMuteItems: (refs: TimelineItemRef[]) => void
  /** Shift every tile in `refs` by `delta` seconds as one undo step, preserving
   *  their relative offsets and durations (the timeline drag applies the same
   *  helper live, then commits once). */
  moveItemsBy: (refs: TimelineItemRef[], delta: number) => void
  /** Butt `refs` up against the tile that precedes them in their lane (or the
   *  timeline start), closing a gap or an overlap. One undo step; a no-op when
   *  they are already flush. */
  snapItemsToPrevious: (refs: TimelineItemRef[], srcDur?: links.SourceDuration) => void
  /**
   * Split every tile in `refs` that the playhead at `atSec` crosses — tiles it
   * misses are left whole. `srcDur` resolves an audio source's duration (only
   * whole-source clips need it). The right-hand halves become their own group.
   */
  splitItemsAt: (refs: TimelineItemRef[], atSec: number, srcDur: links.SourceDuration) => void
  /** Split one layer (video / text / image) at an absolute timeline time. */
  splitLayerAt: (id: string, atSec: number) => void
  splitAudioAt: (audioId: string, atSec: number, sourceDurationSec: number) => void
  /**
   * Drop template `t` (its media already library ids) at `atSec` as one undo
   * step and select what it added (`lib/templates.ts`). `effectSkipped` = it has
   * a clip effect but no clip was under the playhead.
   */
  dropTemplate: (t: ReelTemplate, atSec: number, media: DropMedia) => { effectSkipped: boolean }
}

export const timelineActions = ({ get, commitComp }: Doc): TimelineActions => ({
  linkItems: (refs) => commitComp((p) => links.linkItems(p, refs, newId)),

  unlinkItems: (refs) => commitComp((p) => links.unlinkItems(p, refs)),

  removeItems: (refs) => {
    commitComp((p) => links.removeItems(p, refs))
    useUi.getState().clearSelection() // everything selected is gone
  },

  toggleMuteItems: (refs) => commitComp((p) => links.toggleMuteItems(p, refs)),

  moveItemsBy: (refs, delta) => commitComp((p) => links.moveItemsBy(p, refs, delta)),

  snapItemsToPrevious: (refs, srcDur) => {
    const comp = activeComp(get())
    if (!comp) return
    const delta = links.snapToPreviousDelta(comp, refs, srcDur)
    if (delta === null) return // already flush — don't push an empty undo step
    commitComp((p) => links.moveItemsBy(p, refs, delta))
  },

  splitItemsAt: (refs, atSec, srcDur) => {
    commitComp((p) => links.splitItemsAt(p, refs, atSec, srcDur, newId))
    // A split re-groups the two sides, so the selection has to re-resolve
    // around the tile the user actually clicked (its left half keeps its id)
    // — against the ACTIVE composition, where the tiles live.
    const root = get().project
    const comp = root ? resolveCompAtPath(root, get().editPath) : null
    const ui = useUi.getState()
    const primary = primaryRef(ui)
    if (comp && primary && links.tileOf(comp, primary)) {
      ui.selectItems(links.expandGroup(comp, primary), primary)
    }
  },

  // Both single-tile splits go through the group path so there is exactly one
  // split implementation (a lone tile is just a group of one).
  splitLayerAt: (id, atSec) => get().splitItemsAt([{ kind: 'layer', id }], atSec, () => 0),

  splitAudioAt: (audioId, atSec, sourceDurationSec) =>
    get().splitItemsAt([{ kind: 'audio', id: audioId }], atSec, () => sourceDurationSec),

  dropTemplate: (t, atSec, media) => {
    let added: TimelineItemRef[] = []
    let effectSkipped = false
    commitComp((p) => {
      const res = applyTemplate(p, t, atSec, media, newId)
      added = res.added
      effectSkipped = res.effectSkipped
      return res.comp
    })
    if (added.length) useUi.getState().selectItems(added, added[0])
    return { effectSkipped }
  }
})
