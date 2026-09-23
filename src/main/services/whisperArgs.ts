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

/**
 * whisper-cli args for a word-level transcription.
 *
 * `-ml 1 -sow` gives one entry per word; `-ojf` is required for the per-token
 * `t_dtw` field. When a preset is supplied, `-nfa` MUST ride along: flash
 * attention is on by default and silently disables DTW.
 */
export function buildWhisperArgs(
  model: string,
  wav: string,
  outPrefix: string,
  preset: string | null
): string[] {
  const args = ['-m', model, '-f', wav, '-ml', '1', '-sow', '-ojf', '-of', outPrefix, '-np']
  return preset ? [...args, '-dtw', preset, '-nfa'] : args
}
