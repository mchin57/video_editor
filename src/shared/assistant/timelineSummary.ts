/**
 * A composition as compact JSON for the AI assistant (`get_timeline`). Layers
 * are listed by start time (not stack order); captions are left out. Pure.
 */

import type { Composition, Layer, TransitionKind } from '../project'
import { audioClipEnd } from '../project'
import { compositionDuration, type SourceDuration } from '../compositions'
import { workoutSpeed } from '../workoutOverlay'
import { hasVolumeLine, sortedVolumeKeyframes } from '../audioEnvelope'
import { audioHoldSpans, audioSpeed, audioTimelineAt } from '../audioTiming'
import { pairOf, transitionOf, type TransitionSide } from '../transitions'

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
  /** Video / image: how it comes in at its start and goes out at its end
   *  (absent = a cut). `withId` = the clip a cross dissolve / dip joins it to
   *  (they overlap by `sec`); absent on a plain fade. @see shared/transitions.ts */
  transitionIn?: TransitionSummary
  transitionOut?: TransitionSummary
}

export interface TransitionSummary {
  kind: TransitionKind
  sec: number
  withId?: string
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
  /** Constant playback speed when not 1 (pitch kept; 0.5 = twice as long). */
  speed?: number
  /** Silent holds (where the linked clip is frozen): each from TIMELINE atSec
   *  for holdSec seconds. Absent = none. */
  holds?: { atSec: number; holdSec: number }[]
}

export interface TimelineSummary {
  /** Total composition duration: open-ended audio clips count toward this only when `srcDur` supplies their source length. */
  durationSec: number
  layers: LayerSummary[]
  audioClips: AudioSummary[]
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000

function transitionSummary(layers: Layer[], l: Layer, side: TransitionSide): TransitionSummary | null {
  const tr = transitionOf(l, side)
  if (!tr) return null
  const pair = pairOf(layers, l.id, side)
  const withId = pair ? (side === 'in' ? pair.outId : pair.inId) : undefined
  return { kind: tr.kind, sec: r3(tr.sec), ...(withId ? { withId } : {}) }
}

function layerSummary(l: Layer, layers: Layer[]): LayerSummary {
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
  const tin = transitionSummary(layers, l, 'in')
  const tout = transitionSummary(layers, l, 'out')
  if (tin) s.transitionIn = tin
  if (tout) s.transitionOut = tout
  return s
}

/**
 * Summarize a composition for the AI assistant. Open-ended audio clips
 * (`outSec <= 0`) get an endSec only when `srcDur` supplies their source length.
 */
export function summarizeTimeline(comp: Composition, srcDur: SourceDuration = () => 0): TimelineSummary {
  const layers = [...comp.layers].sort((a, b) => a.startSec - b.startSec).map((l) => layerSummary(l, comp.layers))
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
    if (audioSpeed(c) !== 1) a.speed = r3(audioSpeed(c))
    const holds = audioHoldSpans(c, bounded ? c.outSec : srcLen > 0 ? srcLen : Infinity)
    if (holds.length > 0) a.holds = holds.map((h) => ({ atSec: r3(h.startSec), holdSec: r3(h.holdSec) }))
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
