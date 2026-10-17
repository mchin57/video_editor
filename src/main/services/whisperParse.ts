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

/** A silent interval (source seconds), as silencedetect reports it. */
export interface Silence {
  start: number
  end: number
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

// whisper's own control tokens, e.g. [_BEG_], [_TT_220]. They carry no audio.
const SPECIAL = /^\[_.*\]$/

/**
 * Longest annotation span, in spoken entries from the opening mark to the
 * closing one inclusive. The longest real one is a ♪ lyric line: 10 entries
 * (`♪` + 8 words + `♪`). Past this, an opener is treated as unclosed.
 */
export const MAX_ANNOTATION_ENTRIES = 12

const NOTE = '♪'
const CLOSER: Record<string, string> = { '(': ')', '[': ']' }
const OPENER: Record<string, string> = { ')': '(', ']': '[' }

/** The entry without trailing sentence punctuation (`music).` ends with `)`). */
const bare = (t: string): string => t.replace(/[.,!?;:]+$/, '')
/** A bracket annotation opening here: `(birds`, `[`, `(clicking)`. */
const bracketOpener = (t: string): string | null => (t[0] in CLOSER ? t[0] : null)
/** A bracket closing here — `chirping)`, `]` — not a word with a bracket in it (`friend(s)`). */
function bracketCloser(t: string): string | null {
  const b = bare(t)
  const last = b[b.length - 1]
  return last in OPENER && !b.includes(OPENER[last]) ? last : null
}
/** A `♪` at either end of the entry. */
const isNote = (t: string): boolean => t.startsWith(NOTE) || bare(t).endsWith(NOTE)
/** A whole annotation in one entry: `(clicking)`, `[BLANK_AUDIO]`, `♪♪`. */
function selfContained(t: string): boolean {
  const open = t.startsWith(NOTE) ? NOTE : bracketOpener(t)
  return open != null && t.slice(1).includes(open === NOTE ? NOTE : CLOSER[open])
}

/**
 * Which entries are non-speech annotations, by index. With `-ml 1` whisper
 * splits an annotation into one entry per word — `(birds` `chirping)`,
 * `[` `Pause` `]`, `♪` `I` `could` … `♪` — so a whole-string check misses it.
 *
 * Only marks at an entry's EDGE count: a word with a bracket inside it
 * (`friend(s)`) is speech. Empty entries are not counted.
 *  - Brackets: an entry opening with `(` or `[` starts a span; the first later
 *    entry ending with the matching closer ends it, and everything between
 *    goes. The search gives up at the next opener (of any kind) or after
 *    MAX_ANNOTATION_ENTRIES: the opener was stray, and only it is dropped — it
 *    never pairs with a LATER annotation's mark across the speech between.
 *    A stray closer is dropped alone too.
 *  - `♪` opens and closes alike, so the marks are paired in runs (each within
 *    MAX_ANNOTATION_ENTRIES of the next): in order when the run is even; when
 *    it is odd one mark is stray, and the pairing that drops the FEWEST
 *    entries wins (ties: the last mark is the stray) — when it is ambiguous,
 *    speech is kept rather than swallowed.
 */
export function annotationMask(texts: string[]): boolean[] {
  const drop = texts.map(() => false)
  const spoken = texts.flatMap((t, i) => (t.length > 0 ? [i] : []))
  const at = (n: number): string => texts[spoken[n]]
  const dropRange = (a: number, b: number): void => {
    for (let k = a; k <= b; k++) drop[spoken[k]] = true
  }

  // Brackets.
  for (let n = 0; n < spoken.length; n++) {
    const text = at(n)
    const open = bracketOpener(text)
    if (!open) {
      if (bracketCloser(text)) drop[spoken[n]] = true // a stray closer
      continue
    }
    drop[spoken[n]] = true
    if (selfContained(text)) continue
    const limit = Math.min(spoken.length, n + MAX_ANNOTATION_ENTRIES)
    for (let m = n + 1; m < limit; m++) {
      const t = at(m)
      if (bracketCloser(t) === CLOSER[open]) {
        dropRange(n, m)
        n = m
        break
      }
      if (bracketOpener(t) || isNote(t)) break // another annotation starts: this opener was stray
    }
  }

  // ♪ marks, in runs whose neighbours are within reach of each other.
  const notes: number[] = []
  for (let n = 0; n < spoken.length; n++) {
    const text = at(n)
    if (!isNote(text)) continue
    drop[spoken[n]] = true
    if (!selfContained(text)) notes.push(n)
  }
  let start = 0
  while (start < notes.length) {
    let end = start + 1
    while (end < notes.length && notes[end] - notes[end - 1] < MAX_ANNOTATION_ENTRIES) end++
    const run = notes.slice(start, end)
    start = end
    // Candidate strays: none for an even run; an even index for an odd one
    // (removing it leaves the rest paired in order).
    const strays = run.length % 2 === 0 ? [-1] : run.map((_, i) => i).filter((i) => i % 2 === 0)
    const pairsWithout = (stray: number): [number, number][] => {
      const rest = run.filter((_, i) => i !== stray)
      return rest.flatMap((a, i) => (i % 2 === 0 ? [[a, rest[i + 1]] as [number, number]] : []))
    }
    const cost = (stray: number): number => pairsWithout(stray).reduce((sum, [a, b]) => sum + b - a + 1, 0)
    let best = strays[strays.length - 1]
    for (const s of strays) if (cost(s) < cost(best)) best = s
    for (const [a, b] of pairsWithout(best)) dropRange(a, b)
  }
  return drop
}

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

/**
 * End each word where its sound stops. DTW gives a word's START only; its end
 * is inferred from the next word's start, so the word before a pause is
 * stretched across the pause. That stretch moves the word's midpoint — which
 * decides which side of a cut owns it (renderer/lib/captions.ts) — past a cut
 * the word really sits before, and the clip loses its last word (measured:
 * "months." spoken 10.49–10.59s, stretched to 11.69s, dropped from a clip
 * ending at 11.03s). Only ever pulls an end EARLIER, never later.
 *
 * `silences` is ffmpeg silencedetect output in source seconds.
 */
function endAtSilence(words: CaptionWord[], silences: Silence[]): CaptionWord[] {
  if (silences.length === 0) return words
  const quietFrom = silences.map((s) => s.start).sort((a, b) => a - b)
  return words.map((w) => {
    const stop = quietFrom.find((t) => t > w.startSec)
    return stop !== undefined && stop < w.endSec ? { ...w, endSec: stop } : w
  })
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
  const textual = entries.map((entry, i) => ({ i, text: entryText(entry) })).filter((e) => e.text.length > 0)
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

  const drop = annotationMask(entries.map(entryText))
  const words: CaptionWord[] = []
  for (const { i, text } of textual) {
    if (drop[i]) continue
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
  const entries = json.transcription ?? []
  const drop = annotationMask(entries.map(entryText))
  const words: CaptionWord[] = []
  for (const [i, entry] of entries.entries()) {
    const text = entryText(entry)
    if (!text || drop[i]) continue
    const startSec = (entry.offsets?.from ?? 0) / 1000
    const endSec = (entry.offsets?.to ?? 0) / 1000
    if (!(endSec > startSec)) continue
    words.push({ text, startSec, endSec })
  }
  return words
}

/**
 * Parse a transcript, preferring DTW times and reporting which source won.
 * `silences` (optional) trims each DTW word's end to where its sound stops. The
 * segment fallback ignores them: its starts are smeared, so there is no true
 * start to measure an end from.
 */
export function parseWhisperTranscript(json: WhisperJson, silences: Silence[] = []): ParsedTranscript {
  const dtw = parseDtwWords(json.transcription ?? [])
  if (dtw && dtw.length > 0) return { words: capWords(endAtSilence(dtw, silences)), timing: 'dtw' }
  return { words: capWords(parseWhisperJson(json)), timing: 'segment' }
}
