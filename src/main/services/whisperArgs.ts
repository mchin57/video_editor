/**
 * PURE builder for the whisper-cli argument list. Kept apart from whisper.ts so
 * the tricky part — mapping a model file to its `-dtw` alignment preset — is
 * unit-testable without pulling in electron.
 *
 * See docs/FFMPEG-NOTES.md "whisper word timings" for the verified traps behind
 * every flag here.
 */

/** The alignment-head presets whisper-cli accepts for `-dtw` (dots, not dashes). */
const DTW_PRESETS = new Set([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large.v1',
  'large.v2',
  'large.v3',
  'large.v3.turbo'
])

/**
 * Map a model FILE NAME to its `-dtw` preset, or null when unrecognised.
 *
 * Null means "run without DTW", which is the safe outcome. Guessing would be
 * worse than going without: a preset that does NOT match the model produces
 * garbage timings and still exits 0 (verified — words collapse onto a handful
 * of repeated timestamps), whereas an unknown name aborts with exit 3.
 */
export function dtwPreset(modelPath: string): string | null {
  const file = modelPath.split(/[\\/]/).pop() ?? ''
  const stem = file
    .replace(/^ggml-/i, '')
    .replace(/\.bin$/i, '')
    .replace(/-q\d.*$/i, '') // quantised builds, e.g. ggml-small.en-q5_1.bin
  const preset = stem.replace(/^large-v(\d)/i, 'large.v$1').replace(/-turbo$/i, '.turbo')
  return DTW_PRESETS.has(preset) ? preset : null
}

/** Start decoding this long before the first sustained sound, so a soft onset
 *  that silencedetect's -30dB gate hears late is still inside the window. */
export const LEAD_IN_SEC = 0.5

/** A sound burst shorter than this is a click or a bump, not speech. The
 *  opening click on a real teleprompter recording measured 0.105s. */
export const MIN_SOUND_SEC = 0.15

/**
 * Where whisper should start decoding: just before the first sustained sound.
 *
 * whisper DROPS the opening sentence when a file starts with junk ahead of the
 * speech — verified on real media with a 0.1s click followed by 5s of room tone
 * (muting just the click brought the sentence back), and separately with a
 * clean 12s lead (8s was kept). Mid-file pauses are harmless: after prior
 * speech it keeps the sentence across the same gap, so only the head is
 * skipped. Returns 0 when there is nothing to skip or no sustained sound.
 *
 * `silences` is ffmpeg silencedetect output in source seconds.
 */
export function decodeStartSec(
  silences: { start: number; end: number }[],
  durationSec: number
): number {
  let cursor = 0
  let onset: number | null = null
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start - cursor >= MIN_SOUND_SEC) {
      onset = cursor
      break
    }
    // The run before this silence was too short to be speech: skip past it.
    cursor = Math.max(cursor, s.end)
  }
  if (onset === null && durationSec - cursor >= MIN_SOUND_SEC) onset = cursor
  if (onset === null) return 0
  return Math.max(0, onset - LEAD_IN_SEC)
}

/**
 * whisper-cli args for a word-level transcription.
 *
 * `-ml 1 -sow` gives one entry per word; `-ojf` is required for the per-token
 * `t_dtw` field. When a preset is supplied, `-nfa` MUST ride along: flash
 * attention is on by default and silently disables DTW. `-ot` starts decoding
 * at `offsetSec`; whisper keeps every time it reports (entry offsets AND
 * `t_dtw`) in whole-file time, so nothing downstream shifts.
 */
export function buildWhisperArgs(
  model: string,
  wav: string,
  outPrefix: string,
  preset: string | null,
  offsetSec = 0
): string[] {
  const args = ['-m', model, '-f', wav, '-ml', '1', '-sow', '-ojf', '-of', outPrefix, '-np']
  const offsetMs = Math.round(offsetSec * 1000)
  if (offsetMs > 0) args.push('-ot', String(offsetMs))
  return preset ? [...args, '-dtw', preset, '-nfa'] : args
}
