/**
 * PURE parser for whisper.cpp `-oj` JSON output. With `--max-len 1
 * --split-on-word`, each transcription entry is ~one word with millisecond
 * offsets, giving word-level timing in SOURCE time.
 */

import type { CaptionWord } from '@shared/project'

interface WhisperEntry {
  offsets?: { from?: number; to?: number }
  text?: string
}

export interface WhisperJson {
  transcription?: WhisperEntry[]
}

// Non-speech annotations whisper emits, e.g. [BLANK_AUDIO], (music), [_TT_…].
const NOISE = /^[[(].*[\])]$/

export function parseWhisperJson(json: WhisperJson): CaptionWord[] {
  const words: CaptionWord[] = []
  for (const entry of json.transcription ?? []) {
    const text = (entry.text ?? '').trim()
    if (!text || NOISE.test(text)) continue
    const startSec = (entry.offsets?.from ?? 0) / 1000
    const endSec = (entry.offsets?.to ?? 0) / 1000
    if (!(endSec > startSec)) continue
    words.push({ text, startSec, endSec })
  }
  return words
}
