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

/** A media file's transcription, cached as media/<id>/transcript.json. */
export interface Transcript {
  mediaId: string
  /** Words in SOURCE time (before any clip trim is applied). */
  words: CaptionWord[]
  /** Model used, for display/debugging. */
  model: string
  createdAt: string
  /**
   * Which timing source produced `words`. ABSENT on transcripts cached before
   * word-accurate timing existed — those hold the smeared times that dropped
   * words at the head of a trimmed clip, so `getTranscript` treats a missing
   * value as stale and re-transcribes rather than serving them forever.
   */
  timing?: TimingSource
}
