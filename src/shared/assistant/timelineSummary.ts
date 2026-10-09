/**
 * A composition as compact JSON for the AI assistant (`get_timeline`). Layers
 * are listed by start time (not stack order); captions are left out. Pure.
 */

import type { Composition, Layer } from '../project'
import { audioClipEnd } from '../project'
import { visualDuration } from '../layers'

export interface LayerSummary {
  id: string
  kind: Layer['content']['kind']
  startSec: number
  endSec: number
  hidden: boolean
  mediaId?: string
  /** Source window (video only). */
  inSec?: number
  outSec?: number
  text?: string
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
}

export interface TimelineSummary {
  durationSec: number
  layers: LayerSummary[]
  audioClips: AudioSummary[]
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000

function layerSummary(l: Layer): LayerSummary {
  const s: LayerSummary = { id: l.id, kind: l.content.kind, startSec: r3(l.startSec), endSec: r3(l.endSec), hidden: l.hidden }
  const c = l.content
  if (c.kind === 'video') Object.assign(s, { mediaId: c.mediaId, inSec: r3(c.inSec), outSec: r3(c.outSec) })
  else if (c.kind === 'image') s.mediaId = c.mediaId
  else if (c.kind === 'text') s.text = c.text
  if (l.linkGroupId) s.linkGroupId = l.linkGroupId
  return s
}

export function summarizeTimeline(comp: Composition): TimelineSummary {
  const layers = [...comp.layers].sort((a, b) => a.startSec - b.startSec).map(layerSummary)
  const audioClips: AudioSummary[] = comp.audioClips.map((c) => {
    const bounded = c.outSec > 0
    const a: AudioSummary = {
      id: c.id,
      mediaId: c.mediaId,
      startSec: r3(c.startSec),
      endSec: bounded ? r3(audioClipEnd(c, Infinity)) : null,
      inSec: r3(c.inSec),
      outSec: bounded ? r3(c.outSec) : null
    }
    if (c.linkGroupId) a.linkGroupId = c.linkGroupId
    return a
  })
  const audioEnd = audioClips.reduce((m, a) => Math.max(m, a.endSec ?? 0), 0)
  return { durationSec: r3(Math.max(visualDuration(comp.layers), audioEnd)), layers, audioClips }
}
