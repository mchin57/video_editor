/**
 * Build timeline caption segments from per-media transcripts. Captions follow
 * the AUDIO track: each audio source's words (in source time) are projected into
 * timeline time using the source's position and trim, then grouped into short,
 * readable chunks (reel-style). Pure + tested.
 */

import type { CaptionSegment, CaptionWord } from '@shared/project'

/** An audio source on the timeline that captions are derived from. */
export interface CaptionSource {
  mediaId: string
  /** Timeline position of the source's in-point. */
  startSec: number
  inSec: number
  /** Resolved source out-point (effectiveOut). */
  outSec: number
}

export interface CaptionGroupOptions {
  maxWords?: number
  maxChars?: number
  /** Break a segment when the silence before a word exceeds this. */
  gapSec?: number
}

export function buildTimelineCaptions(
  sources: CaptionSource[],
  wordsByMedia: Record<string, CaptionWord[]>,
  options: CaptionGroupOptions = {}
): CaptionSegment[] {
  const maxWords = options.maxWords ?? 4
  const maxChars = options.maxChars ?? 28
  const gapSec = options.gapSec ?? 0.7

  // 1) Project each source's words into timeline time, clipped to its trim range.
  const timelineWords: CaptionWord[] = []
  for (const src of sources) {
    for (const w of wordsByMedia[src.mediaId] ?? []) {
      if (w.endSec <= src.inSec || w.startSec >= src.outSec) continue
      const s = Math.max(w.startSec, src.inSec)
      const e = Math.min(w.endSec, src.outSec)
      timelineWords.push({
        text: w.text,
        startSec: src.startSec + (s - src.inSec),
        endSec: src.startSec + (e - src.inSec)
      })
    }
  }
  timelineWords.sort((a, b) => a.startSec - b.startSec)

  // 2) Group into short segments, breaking on length, pauses, and sentence ends.
  const segments: CaptionSegment[] = []
  let current: CaptionWord[] = []

  const flush = (): void => {
    if (current.length === 0) return
    segments.push({
      id: `cap-${segments.length}`,
      startSec: current[0].startSec,
      endSec: current[current.length - 1].endSec,
      text: current.map((w) => w.text).join(' '),
      words: current.slice(),
      enabled: true
    })
    current = []
  }

  for (const w of timelineWords) {
    if (current.length > 0) {
      const prev = current[current.length - 1]
      const gap = w.startSec - prev.endSec
      const candidateLen = current.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length
      const endsSentence = /[.!?]$/.test(prev.text)
      if (current.length >= maxWords || candidateLen > maxChars || gap > gapSec || endsSentence) {
        flush()
      }
    }
    current.push(w)
  }
  flush()
  return segments
}
