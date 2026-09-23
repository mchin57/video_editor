/**
 * PURE parser for whisper.cpp JSON output. With `--max-len 1 --split-on-word`,
 * each transcription entry is ~one word.
 *
 * Two timing sources, in preference order:
 *
 *  - 'dtw' — per-token `t_dtw` from `-ojf -dtw <preset> -nfa`, in CENTIseconds.
 *    Acoustically aligned, so a word starts where it is actually spoken.
 *
 *  - 'segment' — the entry's own `offsets` (milliseconds). These are SEGMENT
 *    bounds standing in for word times: entries tile edge-to-edge, so the
 *    leading words of a segment get smeared back across whatever silence
 *    precedes the speech (measured 2.42s early on real media) and the word
 *    before a pause absorbs the whole pause. Fallback only.
 *
 * See docs/FFMPEG-NOTES.md "whisper word timings" for the verified traps.
 */

import type { CaptionWord } from '@shared/project'
import type { TimingSource } from '@shared/transcript'

interface WhisperToken {
  text?: string
  /** DTW-aligned token time in CENTIseconds; -1 when not computed. */
  t_dtw?: number
  offsets?: { from?: number; to?: number }
}

interface WhisperEntry {
  offsets?: { from?: number; to?: number }
  text?: string
  tokens?: WhisperToken[]
}

export interface WhisperJson {
  transcription?: WhisperEntry[]
}

export interface ParsedTranscript {
  words: CaptionWord[]
  timing: TimingSource
}

/**
 * Longest window one word may occupy. Word windows tile, so without a cap the
 * word before a pause swallows the pause and captions itself on BOTH sides of a
 * cut made during it. Real speech measured p50 0.24s / p90 0.86s / max 0.94s,
 * so this never truncates a genuine word.
 */
export const MAX_WORD_SEC = 1.2

/** Floor for a word window, so a degenerate one is shortened rather than lost. */
export const MIN_WORD_SEC = 0.08

/**
 * Reject DTW when this share of words merely repeat the previous word's start.
 * A `-dtw` preset that does not match the model collapses runs of words onto a
 * single timestamp AND EXITS 0 — measured 81% duplicates for a mismatch versus
 * 0% for a match, so this gate has a wide margin.
 */
const MAX_DUPLICATE_SHARE = 0.25

// Non-speech annotations whisper emits, e.g. [BLANK_AUDIO], (music), [_TT_…].
const NOISE = /^[[(].*[\])]$/

// whisper's own control tokens, e.g. [_BEG_], [_TT_220]. They carry no audio.
const SPECIAL = /^\[_.*\]$/

const entryText = (e: WhisperEntry): string => (e.text ?? '').trim()

/** DTW time (seconds) of an entry's first real text token, or null. */
function dtwStart(entry: WhisperEntry): number | null {
  for (const token of entry.tokens ?? []) {
    const text = (token.text ?? '').trim()
    if (!text || SPECIAL.test(text)) continue
    if (typeof token.t_dtw === 'number' && token.t_dtw >= 0) return token.t_dtw / 100
  }
  return null
}

/** Clamp every word window into [MIN_WORD_SEC, MAX_WORD_SEC]. */
function capWords(words: CaptionWord[]): CaptionWord[] {
  return words.map((w) => ({
    ...w,
    endSec: Math.min(Math.max(w.endSec, w.startSec + MIN_WORD_SEC), w.startSec + MAX_WORD_SEC)
  }))
}

/**
 * Word list from DTW token times, or null when DTW is absent or untrustworthy
 * (the caller then falls back to segment offsets).
 */
function parseDtwWords(entries: WhisperEntry[]): CaptionWord[] | null {
  // Time every entry, annotations included: a dropped annotation still bounds
  // the end of the word before it.
  const starts = entries.map(dtwStart)
  const textual = entries
    .map((entry, i) => ({ i, text: entryText(entry) }))
    .filter((e) => e.text.length > 0)
  if (textual.length === 0) return null

  // Gate 1: every spoken entry must carry a DTW time. A partial run means DTW
  // was off (or the build ignored it) — mixing the two timebases would reorder
  // words, so take none of it.
  if (textual.some((e) => starts[e.i] === null)) return null

  // Gates 2 + 3: monotonic, and not collapsed onto repeated timestamps.
  let duplicates = 0
  for (let n = 1; n < textual.length; n++) {
    const prev = starts[textual[n - 1].i] as number
    const cur = starts[textual[n].i] as number
    if (cur < prev) return null
    if (cur === prev) duplicates++
  }
  if (textual.length > 1 && duplicates / (textual.length - 1) > MAX_DUPLICATE_SHARE) return null

  const words: CaptionWord[] = []
  for (const { i, text } of textual) {
    if (NOISE.test(text)) continue
    const startSec = starts[i] as number
    // End at the next acoustic event; the final word falls back to its own
    // segment end. capWords() bounds whatever that turns out to be.
    let next: number | null = null
    for (let j = i + 1; j < entries.length; j++) {
      if (starts[j] !== null) {
        next = starts[j]
        break
      }
    }
    words.push({ text, startSec, endSec: next ?? (entries[i].offsets?.to ?? 0) / 1000 })
  }
  return words
}

/** Word list from the entries' own segment offsets. */
export function parseWhisperJson(json: WhisperJson): CaptionWord[] {
  const words: CaptionWord[] = []
  for (const entry of json.transcription ?? []) {
    const text = entryText(entry)
    if (!text || NOISE.test(text)) continue
    const startSec = (entry.offsets?.from ?? 0) / 1000
    const endSec = (entry.offsets?.to ?? 0) / 1000
    if (!(endSec > startSec)) continue
    words.push({ text, startSec, endSec })
  }
  return words
}

/** Parse a transcript, preferring DTW times and reporting which source won. */
export function parseWhisperTranscript(json: WhisperJson): ParsedTranscript {
  const dtw = parseDtwWords(json.transcription ?? [])
  if (dtw && dtw.length > 0) return { words: capWords(dtw), timing: 'dtw' }
  return { words: capWords(parseWhisperJson(json)), timing: 'segment' }
}
