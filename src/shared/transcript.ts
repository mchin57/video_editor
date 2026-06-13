import type { CaptionWord } from './project'

/** A media file's transcription, cached as media/<id>/transcript.json. */
export interface Transcript {
  mediaId: string
  /** Words in SOURCE time (before any clip trim is applied). */
  words: CaptionWord[]
  /** Model used, for display/debugging. */
  model: string
  createdAt: string
}
