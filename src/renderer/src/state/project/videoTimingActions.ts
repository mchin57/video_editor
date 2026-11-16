/**
 * Project store slice: edits that RE-TIME a video clip — constant speed, the
 * speed ramp, freeze holds. Each keeps the window invariant
 * `endSec = startSec + playedBetween(in, out) + Σ holds` (`playedVideoDuration`):
 * never re-derive it inline (CLAUDE.md "Process & time-mapping rules").
 */

import type { Layer, SpeedKeyframe, VideoContent } from '@shared/project'
import { playedVideoDuration, videoSourceTime } from '@shared/layers'
import { hasSpeedRamp, videoSpeedAtSource } from '@shared/speed'
import { addGroupFreeze, removeGroupFreeze, setGroupSpeed } from '@/lib/links'
import { mapVideoLayer, type Doc } from './core'

export interface VideoTimingActions {
  /** Set a video layer's constant playback speed, recomputing its timeline end
   *  from the shared duration invariant (source span / speed + holds) — and on
   *  its linked same-source audio (`setGroupSpeed`, lib/links.ts). */
  setVideoSpeed: (id: string, speed: number) => void
  /** Add (or update) a speed-ramp keyframe at the SOURCE time under timeline
   *  time `atSec`, seeded with the profile's current speed there. Recomputes
   *  the layer end from the shared duration invariant. */
  addSpeedKeyframe: (id: string, atSec: number) => void
  /** Change the speed of the ramp keyframe at `index` (in sorted order). */
  updateSpeedKeyframe: (id: string, index: number, speed: number) => void
  /** Remove the ramp keyframe at `index` (in sorted order). */
  removeSpeedKeyframe: (id: string, index: number) => void
  /** Drop the whole ramp; the clip returns to its constant `speed`. */
  clearSpeedRamp: (id: string) => void
  /** Add a freeze hold at source time `atSrcSec`, extending the layer by
   *  `holdSec` — and the same hold on its linked same-source audio
   *  (`addGroupFreeze`). */
  addFreeze: (id: string, atSrcSec: number, holdSec: number) => void
  /** Remove the freeze at `index`, shrinking the layer by its hold — and the
   *  matching hold on its linked same-source audio (`removeGroupFreeze`). */
  removeFreeze: (id: string, index: number) => void
}

/** `l` playing `content`, its window re-timed to the content's played length. */
const retimed = (l: Layer, content: VideoContent): Layer => ({
  ...l,
  endSec: l.startSec + playedVideoDuration(content),
  content
})

/** The ramp sorted by source time, as the Inspector lists it (indexes refer to this order). */
const sortedRamp = (c: VideoContent): SpeedKeyframe[] => [...(c.speedRamp ?? [])].sort((a, b) => a.atSec - b.atSec)

export const videoTimingActions = ({ commitComp }: Doc): VideoTimingActions => ({
  setVideoSpeed: (id, speed) => commitComp((p) => setGroupSpeed(p, { kind: 'layer', id }, speed)),

  addSpeedKeyframe: (id, atSec) =>
    commitComp((p) =>
      mapVideoLayer(p, id, (l, c) => {
        // Anchor at the SOURCE time under the playhead, seeded with the
        // profile's current speed there — inserting a point on a linear
        // segment leaves the profile (and so the duration) unchanged until
        // the user edits its speed.
        const src = videoSourceTime(c, l, atSec)
        const speed = videoSpeedAtSource(c, src)
        const kept = (c.speedRamp ?? []).filter((k) => Math.abs(k.atSec - src) > 0.02)
        const speedRamp = [...kept, { atSec: src, speed }].sort((a, b) => a.atSec - b.atSec)
        return retimed(l, { ...c, speedRamp })
      })
    ),

  updateSpeedKeyframe: (id, index, speed) =>
    commitComp((p) =>
      mapVideoLayer(p, id, (l, c) => {
        const kfs = sortedRamp(c)
        if (!kfs[index]) return l
        kfs[index] = { ...kfs[index], speed }
        return retimed(l, { ...c, speedRamp: kfs })
      })
    ),

  removeSpeedKeyframe: (id, index) =>
    commitComp((p) =>
      mapVideoLayer(p, id, (l, c) => {
        const kfs = sortedRamp(c)
        if (!kfs[index]) return l
        const next = kfs.filter((_, i) => i !== index)
        return retimed(l, { ...c, speedRamp: next.length ? next : undefined })
      })
    ),

  clearSpeedRamp: (id) =>
    commitComp((p) =>
      mapVideoLayer(p, id, (l, c) => (hasSpeedRamp(c) ? retimed(l, { ...c, speedRamp: undefined }) : l))
    ),

  addFreeze: (id, atSrcSec, holdSec) => commitComp((p) => addGroupFreeze(p, { kind: 'layer', id }, atSrcSec, holdSec)),

  removeFreeze: (id, index) => commitComp((p) => removeGroupFreeze(p, { kind: 'layer', id }, index))
})
