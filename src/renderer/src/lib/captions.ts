/**
 * Build timeline caption segments from per-media transcripts. Each clip's words
 * (in source time) are projected into timeline time honoring the clip's trim and
 * position, then grouped into short, readable chunks (reel-style). Pure + tested.
 */

import type { CaptionSegment, CaptionWord, Clip } from '@shared/project'
import { clipStartTimes } from './timeline'

export interface CaptionGroupOptions {
  maxWords?: number
  maxChars?: number
  /** Break a segment when the silence before a word exceeds this. */
  gapSec?: number
}

export function buildTimelineCaptions(
  clips: Clip[],
  wordsByMedia: Record<string, CaptionWord[]>,
  options: CaptionGroupOptions = {}
): CaptionSegment[] {
  const maxWords = options.maxWords ?? 4
  const maxChars = options.maxChars ?? 28
  const gapSec = options.gapSec ?? 0.7
  const starts = clipStartTimes(clips)

  // 1) Project each clip's words into timeline time, clipped to its trim range.
  const timelineWords: CaptionWord[] = []
  clips.forEach((clip, i) => {
    const clipStart = starts[i]
    for (const w of wordsByMedia[clip.mediaId] ?? []) {
      if (w.endSec <= clip.inSec || w.startSec >= clip.outSec) continue
      const s = Math.max(w.startSec, clip.inSec)
      const e = Math.min(w.endSec, clip.outSec)
      timelineWords.push({
        text: w.text,
        startSec: clipStart + (s - clip.inSec),
        endSec: clipStart + (e - clip.inSec)
      })
    }
  })
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
