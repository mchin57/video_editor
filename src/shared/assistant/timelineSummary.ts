/**
 * A composition as compact JSON for the AI assistant (`get_timeline`). Layers
 * are listed by start time (not stack order); captions are left out. Pure.
 */

import type { Composition, Layer } from '../project'
import { audioClipEnd } from '../project'
import { compositionDuration, type SourceDuration } from '../compositions'
import { workoutSpeed } from '../workoutOverlay'
import { hasVolumeLine, sortedVolumeKeyframes } from '../audioEnvelope'
import { audioTimelineAt } from '../audioTiming'

export interface LayerSummary {
  id: string
  kind: Layer['content']['kind']
  startSec: number
  endSec: number
  hidden: boolean
  mediaId?: string
  /** Source window (video), or the stretch of the recording shown (workout). */
  inSec?: number
  outSec?: number
  text?: string
  /** Workout overlay: seconds of the recording per second of video, and the
   *  metrics its widgets show (`power`, `liveMap`, …). */
  speed?: number
  shows?: string[]
  linkGroupId?: string
}

export interface AudioSummary {
  id: string
  mediaId: string
  startSec: number
  /** null = plays to the end of its source. */
  endSec: number | null
  inSec: number
  outSec: number | null
  linkGroupId?: string
  /** The clip's volume line, when it has one: each point at the TIMELINE second
   *  it plays (it stays on its sound in the source) and its dB over the clip's
   *  normal volume (−60 = silence). Absent = flat. @see shared/audioEnvelope.ts */
  volumeLine?: { atSec: number; db: number }[]
}

export interface TimelineSummary {
  /** Total composition duration: open-ended audio clips count toward this only when `srcDur` supplies their source length. */
  durationSec: number
  layers: LayerSummary[]
  audioClips: AudioSummary[]
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000

function layerSummary(l: Layer): LayerSummary {
  const s: LayerSummary = {
    id: l.id,
    kind: l.content.kind,
    startSec: r3(l.startSec),
    endSec: r3(l.endSec),
    hidden: l.hidden
  }
  const c = l.content
  if (c.kind === 'video') Object.assign(s, { mediaId: c.mediaId, inSec: r3(c.inSec), outSec: r3(c.outSec) })
  else if (c.kind === 'image') s.mediaId = c.mediaId
  else if (c.kind === 'text') s.text = c.text
  else if (c.kind === 'workout') {
    Object.assign(s, {
      mediaId: c.mediaId,
      inSec: r3(c.inSec),
      outSec: r3(c.outSec),
      speed: r3(workoutSpeed(c)),
      shows: c.widgets.map((w) => w.metric)
    })
  }
  if (l.linkGroupId) s.linkGroupId = l.linkGroupId
  return s
}

/**
 * Summarize a composition for the AI assistant. Open-ended audio clips
 * (`outSec <= 0`) get an endSec only when `srcDur` supplies their source length.
 */
export function summarizeTimeline(comp: Composition, srcDur: SourceDuration = () => 0): TimelineSummary {
  const layers = [...comp.layers].sort((a, b) => a.startSec - b.startSec).map(layerSummary)
  const audioClips: AudioSummary[] = comp.audioClips.map((c) => {
    const bounded = c.outSec > 0
    const srcLen = bounded ? Infinity : srcDur(c.mediaId)
    const a: AudioSummary = {
      id: c.id,
      mediaId: c.mediaId,
      startSec: r3(c.startSec),
      endSec: srcLen > 0 ? r3(audioClipEnd(c, srcLen)) : null,
      inSec: r3(c.inSec),
      outSec: bounded ? r3(c.outSec) : null
    }
    if (c.linkGroupId) a.linkGroupId = c.linkGroupId
    if (hasVolumeLine(c)) {
      a.volumeLine = sortedVolumeKeyframes(c).map((k) => ({
        atSec: r3(audioTimelineAt(c, k.sourceSec)),
        db: k.db
      }))
    }
    return a
  })
  return { durationSec: r3(compositionDuration(comp, srcDur)), layers, audioClips }
}
