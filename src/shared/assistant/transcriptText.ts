/**
 * Transcript → compact text for the AI assistant (`get_transcript`). Phrase
 * lines keep token cost low; word lines are for cutting on a precise word.
 * All times are SOURCE time (seconds into the media file). Pure.
 */

import type { CaptionWord } from '../project'

/** A pause at least this long between two words starts a new phrase (s). */
export const PHRASE_GAP_SEC = 0.6
/** A phrase is also closed after this many words so lines stay scannable. */
export const PHRASE_MAX_WORDS = 14

export interface TranscriptRange {
  fromSec: number
  toSec: number
}

const fmt = (s: number): string => s.toFixed(2)

/** Words whose span overlaps `range` (all of them when absent). */
export function wordsInRange(words: CaptionWord[], range?: TranscriptRange): CaptionWord[] {
  if (!range) return words
  return words.filter((w) => w.endSec > range.fromSec && w.startSec < range.toSec)
}

/** Group words into phrases: break on a pause, after sentence punctuation, or at the word cap. */
export function phrases(words: CaptionWord[]): CaptionWord[][] {
  const out: CaptionWord[][] = []
  let cur: CaptionWord[] = []
  for (const w of words) {
    const prev = cur[cur.length - 1]
    const breakHere =
      prev !== undefined &&
      (w.startSec - prev.endSec >= PHRASE_GAP_SEC ||
        /[.!?]$/.test(prev.text.trim()) ||
        cur.length >= PHRASE_MAX_WORDS)
    if (breakHere) {
      out.push(cur)
      cur = []
    }
    cur.push(w)
  }
  if (cur.length) out.push(cur)
  return out
}

/** `[12.34–15.80] text` per phrase. */
export function transcriptPhraseText(words: CaptionWord[], range?: TranscriptRange): string {
  const ws = wordsInRange(words, range)
  if (!ws.length) return '(no speech)'
  return phrases(ws)
    .map((p) => `[${fmt(p[0].startSec)}–${fmt(p[p.length - 1].endSec)}] ${p.map((w) => w.text.trim()).join(' ')}`)
    .join('\n')
}

/** `12.34–12.61 word` per word. */
export function transcriptWordText(words: CaptionWord[], range?: TranscriptRange): string {
  const ws = wordsInRange(words, range)
  if (!ws.length) return '(no speech)'
  return ws.map((w) => `${fmt(w.startSec)}–${fmt(w.endSec)} ${w.text.trim()}`).join('\n')
}
