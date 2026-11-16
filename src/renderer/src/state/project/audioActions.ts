/** Project store slice: AUDIO clips of the active composition, generated effect
 *  tracks, split on silence, and volume levels (a root-level list;
 *  shared/volumeLevels.ts). */

import type { AudioClip, VolumeKeyframe } from '@shared/project'
import type { AudioFx } from '@shared/audioFx'
import { withVolumeKeyframes } from '@shared/audioEnvelope'
import { updateCompAtPath } from '@shared/compositions'
import {
  addVolumeLevel,
  removeVolumeLevel,
  renameVolumeLevel,
  setVolumeLevelTarget,
  withVolumeLevel
} from '@shared/volumeLevels'
import { newId } from '@shared/ids'
import { audioTimelineAt } from '@shared/audioTiming'
import { withAudioHolds } from '@/lib/timeline'
import * as links from '@/lib/links'
import { replaceAt, updateById } from '@/lib/arrays'
import type { Doc } from './core'

export interface AudioActions {
  addAudioClip: (clip: AudioClip) => void
  updateAudioClip: (id: string, patch: Partial<AudioClip>) => void
  /** Replace a clip's volume line (empty = flat, the field is removed). One
   *  undo step; a tile drag edits through `liveUpdate` + `commitLive` instead. */
  setVolumeKeyframes: (id: string, points: VolumeKeyframe[]) => void
  removeAudioClip: (id: string) => void
  /** Set an audio clip's constant speed (pitch kept; 1 removes the field) — and
   *  on every same-source member of its link group, re-placed so they stay in
   *  sync (`links.setGroupSpeed`). One undo step; a no-op while the group is
   *  locked (`links.retimeLock`). */
  setAudioSpeed: (id: string, speed: number, srcDur?: links.SourceDuration) => void
  /**
   * Point every piece of a re-rendered effect at its new asset, keeping each
   * piece's own position and TRIM. A split effect track is several clips over
   * ONE rendered file, so re-rendering has to move them all together — updating
   * just the selected piece would leave its siblings playing the old render.
   */
  replaceAudioFxRender: (fromMediaId: string, toMediaId: string, fx: AudioFx) => void
  /** Split an audio clip into its speech `ranges` (source seconds), dropping
   *  the silent stretches. A LINKED clip cuts its whole group at the same
   *  timeline seconds (`links.splitGroupOnSilence`; needs `srcDur`). One undo step. */
  splitAudioOnSilence: (
    audioId: string,
    ranges: { start: number; end: number }[],
    srcDur?: links.SourceDuration
  ) => void
  /** Create a level named `name` (the default target) and put the ACTIVE
   *  comp's clips `assign` in it — one undo step. Returns the new level's id. */
  createVolumeLevel: (name: string, assign?: string[]) => string
  /** Rename a level (Default keeps its name). */
  renameVolumeLevel: (id: string, name: string) => void
  /** Set a level's loudness (LUFS) — every clip in it follows. */
  setVolumeLevelTarget: (id: string, targetLufs: number) => void
  /** Delete a level; its clips return to their own volume. One undo step;
   *  Default can't be deleted. */
  deleteVolumeLevel: (id: string) => void
  /** Put the ACTIVE comp's clips `ids` in `levelId` (null = none). Effect
   *  tracks are skipped — they follow their source clip. */
  setClipsVolumeLevel: (ids: string[], levelId: string | null) => void
}

export const audioActions = ({ get, commit, commitComp }: Doc): AudioActions => ({
  addAudioClip: (clip) => commitComp((p) => ({ ...p, audioClips: [...p.audioClips, clip] })),

  updateAudioClip: (id, patch) =>
    commitComp((p) => ({ ...p, audioClips: updateById(p.audioClips, id, (a) => ({ ...a, ...patch })) })),

  setVolumeKeyframes: (id, points) =>
    commitComp((p) => ({ ...p, audioClips: updateById(p.audioClips, id, (a) => withVolumeKeyframes(a, points)) })),

  removeAudioClip: (id) => commitComp((p) => links.removeItems(p, [{ kind: 'audio', id }])),

  setAudioSpeed: (id, speed, srcDur) => commitComp((p) => links.setGroupSpeed(p, { kind: 'audio', id }, speed, srcDur)),

  // Deliberately does NOT touch inSec/outSec: a piece of a split effect track
  // is trimmed into the rendered file, and resetting the trim would expand it
  // back to the whole effect at its own start point.
  replaceAudioFxRender: (fromMediaId, toMediaId, fx) =>
    commitComp((p) => ({
      ...p,
      audioClips: p.audioClips.map((a) => (a.fx && a.mediaId === fromMediaId ? { ...a, mediaId: toMediaId, fx } : a))
    })),

  splitAudioOnSilence: (audioId, ranges, srcDur = () => 0) =>
    commitComp((p) => {
      if (links.isLinked(p, { kind: 'audio', id: audioId })) {
        return links.splitGroupOnSilence(p, audioId, ranges, srcDur, newId)
      }
      const idx = p.audioClips.findIndex((a) => a.id === audioId)
      if (idx < 0 || ranges.length === 0) return p
      const orig = p.audioClips[idx]
      // Each piece starts where its first sound plays on the clip as it is
      // timed now (`audioTimelineAt`: speed and holds), and keeps its own holds.
      const pieces: AudioClip[] = ranges.map((r) =>
        withAudioHolds(
          {
            ...orig,
            id: newId(),
            inSec: r.start,
            outSec: r.end,
            startSec: audioTimelineAt(orig, r.start),
            fadeInSec: 0,
            fadeOutSec: 0
          },
          (orig.freezes ?? []).filter((f) => f.atSec >= r.start && f.atSec <= r.end)
        )
      )
      return { ...p, audioClips: replaceAt(p.audioClips, idx, 1, ...pieces) }
    }),

  createVolumeLevel: (name, assign = []) => {
    const id = newId()
    const keys = new Set(assign)
    commit((p) =>
      updateCompAtPath(addVolumeLevel(p, { id, name }), get().editPath, (c) => ({
        ...c,
        audioClips: c.audioClips.map((a) => (keys.has(a.id) ? withVolumeLevel(a, id) : a))
      }))
    )
    return id
  },

  renameVolumeLevel: (id, name) => commit((p) => renameVolumeLevel(p, id, name)),

  setVolumeLevelTarget: (id, targetLufs) => commit((p) => setVolumeLevelTarget(p, id, targetLufs)),

  deleteVolumeLevel: (id) => commit((p) => removeVolumeLevel(p, id)),

  setClipsVolumeLevel: (ids, levelId) => {
    const keys = new Set(ids)
    const levels = get().project?.volumeLevels ?? []
    if (levelId && !levels.some((l) => l.id === levelId)) return
    commitComp((c) => {
      let changed = false
      const audioClips = c.audioClips.map((a) => {
        if (!keys.has(a.id)) return a
        const next = withVolumeLevel(a, levelId)
        if (next !== a) changed = true
        return next
      })
      return changed ? { ...c, audioClips } : c
    })
  }
})
