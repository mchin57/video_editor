import type { CaptionWord } from './project'

/**
 * Where a transcript's word times came from.
 *  - 'dtw'     — whisper's DTW token alignment: the word starts when it is
 *                actually spoken.
 *  - 'segment' — whisper's per-entry `offsets`, which are SEGMENT bounds
 *                standing in for word times. They tile edge-to-edge and smear
 *                the leading words of a segment back across any silence before
 *                the speech (measured up to 2.42s early). Fallback only.
 */
export type TimingSource = 'dtw' | 'segment'

/**
 * Bump whenever a change to the whisper invocation or the parse would change
 * what `words` holds for the same media. Cached transcripts from any other
 * version are re-transcribed on next use — there is no other way to redo one.
 *  1 — DTW word timings (no `version` field was written).
 *  2 — decoding starts just before the first sustained sound, so the opening
 *      sentence is no longer dropped after a click or a long lead-in.
 */
export const TRANSCRIPT_VERSION = 2

/** A media file's transcription, cached as media/<id>/transcript.json. */
export interface Transcript {
  mediaId: string
  /** Words in SOURCE time (before any clip trim is applied). */
  words: CaptionWord[]
  /** Model used, for display/debugging. */
  model: string
  createdAt: string
  /** Which timing source produced `words`. */
  timing?: TimingSource
  /** `TRANSCRIPT_VERSION` at the time of writing; absent before version 2. */
  version?: number
  /** Source second whisper started decoding from (0 = the whole file). */
  decodeStartSec?: number
}

/** Whether a cached transcript was made by the current pipeline. */
export function isCurrentTranscript(t: Transcript): boolean {
  return t.version === TRANSCRIPT_VERSION
}
