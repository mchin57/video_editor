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

/**
 * Keep a word that lands this close to a trim edge but just outside it. Covers
 * the residual disagreement between a cut and whisper's word alignment; it is
 * NOT what makes edge words survive — accurate word times are (see
 * main/services/whisperParse.ts). Deliberately far smaller than the gap between
 * clips, so a word can never leak in from a neighbouring take.
 */
const EDGE_TOLERANCE_SEC = 0.15

/** Least time a word may be shown, so one straddling a cut is not a flash. */
const MIN_VISIBLE_SEC = 0.12

/**
 * Does this source own the word — i.e. should it caption it?
 *
 * A word the cut lands inside goes to whichever side holds MORE of it, the same
 * rule `splitCaptionSegment` uses when cutting a caption block. Without it both
 * halves caption the word and the short side flashes a fragment that belongs to
 * its neighbour. A word that misses the window entirely is judged on tolerance
 * instead: no overlap to weigh, so that is alignment jitter, not a split.
 */
function ownsWord(src: CaptionSource, w: CaptionWord): boolean {
  const overlap = Math.min(w.endSec, src.outSec) - Math.max(w.startSec, src.inSec)
  if (overlap <= 0) {
    return w.endSec > src.inSec - EDGE_TOLERANCE_SEC && w.startSec < src.outSec + EDGE_TOLERANCE_SEC
  }
  // A word covering the whole window is all this source has; keep it.
  if (w.startSec <= src.inSec && w.endSec >= src.outSec) return true
  const mid = (w.startSec + w.endSec) / 2
  return mid >= src.inSec && mid < src.outSec
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
    const room = src.outSec - src.inSec
    if (room <= 0) continue
    for (const w of wordsByMedia[src.mediaId] ?? []) {
      if (!ownsWord(src, w)) continue
      let s = Math.max(w.startSec, src.inSec)
      let e = Math.min(w.endSec, src.outSec)
      // A word straddling (or just missing) the cut gets pinned to the edge for
      // a readable moment instead of flashing by in a few frames.
      const want = Math.min(MIN_VISIBLE_SEC, room)
      if (e - s < want) {
        e = Math.min(s + want, src.outSec)
        s = Math.max(e - want, src.inSec)
      }
      if (!(e > s)) continue
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
