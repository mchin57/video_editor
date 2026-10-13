/**
 * Loudness series — the per-asset loudness timeline volume levels match clips
 * with — and the window math both preview and export read it through.
 *
 * Main measures it once per media asset with audio (`services/loudness.ts`,
 * one ffmpeg pass: `ebur128` momentary loudness + an `astats` sample peak per
 * 0.1 s) and caches it as `cache/<id>/loudness.json`. Disposable like every
 * cache file: delete it and it is measured again.
 *
 * File shape (JSON, `LOUDNESS_VERSION` 1):
 *
 *   {
 *     "version": 1,
 *     "stepSec": 0.1,
 *     "startSec": 0,
 *     "momentary": [null, null, null, -66.21, -40.5, ...],
 *     "peak": [-56.1, -54.81, ...]
 *   }
 *
 * Entry `i` is the 0.1 s step `[startSec + i·step, startSec + (i+1)·step)`:
 *  - `momentary[i]` — momentary loudness (LUFS) of the 400 ms block ENDING at
 *    that step's end, i.e. the span `(t + 0.1 − 0.4, t + 0.1]` for step start
 *    `t`. `null` while no full block exists yet (the first three entries) and
 *    for digital silence (ffmpeg reports `nan` / its −120.7 floor there).
 *  - `peak[i]` — the sample peak (dBFS) of that step alone. `null` = digital
 *    silence (`-inf`).
 * Both arrays have one entry per step (the last step may be shorter). Values
 * are rounded to 0.01 dB. `startSec` is the source time of the first decoded
 * audio sample (0 for nearly every file).
 *
 * Measured on the asset's audio as the mix hears it: mono-folded when the
 * probe says so, at the source's own channel count (a mono source is NOT
 * upmixed — the stereo proxy has the same loudness but a 3 dB lower peak, so
 * the source peak is the safe upper bound). See FFMPEG-NOTES "Loudness series".
 */

/** Bump when the measurement or file shape changes; other versions are re-measured. */
export const LOUDNESS_VERSION = 1
/** Seconds per series entry. */
export const LOUDNESS_STEP_SEC = 0.1
/** BS.1770 gating block length (momentary loudness window). */
export const LOUDNESS_BLOCK_SEC = 0.4
/** BS.1770 absolute gate (LUFS). */
export const ABSOLUTE_GATE_LUFS = -70
/** BS.1770 relative gate (LU below the absolute-gated mean). */
export const RELATIVE_GATE_LU = -10

export interface LoudnessSeries {
  version: number
  stepSec: number
  startSec: number
  /** LUFS of the 400 ms block ending at the end of step i; null = no block / silence. */
  momentary: (number | null)[]
  /** Sample peak (dBFS) of step i; null = digital silence. */
  peak: (number | null)[]
}

export type WindowLoudness =
  /** The window is under one 400 ms block: there is nothing to gate. */
  | { status: 'tooShort' }
  | {
      status: 'ok'
      /** Gated integrated loudness (LUFS); null when no block passes the
       *  absolute gate (silence, or the window lies past the audio's end). */
      lufs: number | null
      /** Highest sample peak (dBFS) in the window; null = digital silence. */
      peakDb: number | null
    }

/** Whether parsed JSON is a series of the current version (else re-measure). */
export function isLoudnessSeries(x: unknown): x is LoudnessSeries {
  if (!x || typeof x !== 'object') return false
  const s = x as Partial<LoudnessSeries>
  return (
    s.version === LOUDNESS_VERSION &&
    typeof s.stepSec === 'number' &&
    s.stepSec > 0 &&
    typeof s.startSec === 'number' &&
    Array.isArray(s.momentary) &&
    Array.isArray(s.peak)
  )
}

/** Block power (BS.1770 mean square, K-weighted) from its loudness. */
const power = (lufs: number): number => Math.pow(10, (lufs + 0.691) / 10)
const loudnessOf = (meanPower: number): number => -0.691 + 10 * Math.log10(meanPower)

/**
 * Gated integrated loudness and peak of the source range `[inSec, outSec)`,
 * the way `ebur128` measures that range on its own (BS.1770-4 gating:
 * absolute −70 LUFS, relative −10 LU).
 *
 * A block counts when its whole 400 ms span lies inside the window, with the
 * window's edges snapped to the nearest 0.1 s step (the series' grid; exact
 * for grid-aligned windows, and a window of 0.4 s or more always keeps at
 * least one block). The peak covers every step the window touches — never
 * lower than the true peak, since a cap is built on it.
 */
export function windowLoudness(series: LoudnessSeries, inSec: number, outSec: number): WindowLoudness {
  if (!(outSec - inSec >= LOUDNESS_BLOCK_SEC - 1e-9)) return { status: 'tooShort' }
  const { stepSec, startSec, momentary, peak } = series
  const blockSteps = Math.round(LOUDNESS_BLOCK_SEC / stepSec)
  const a = (inSec - startSec) / stepSec
  const b = (outSec - startSec) / stepSec

  // Blocks: entry i spans steps [i + 1 − blockSteps, i + 1]. The epsilon makes
  // both edges round the same way despite float noise (1.45 / 0.1 = 14.4999…),
  // which is what guarantees a block for any window of 0.4 s or more.
  const snap = (x: number): number => Math.round(x + 1e-6)
  const first = Math.max(0, snap(a) + blockSteps - 1)
  const last = Math.min(momentary.length - 1, snap(b) - 1)
  const gated: number[] = []
  for (let i = first; i <= last; i++) {
    const m = momentary[i]
    if (m != null && m > ABSOLUTE_GATE_LUFS) gated.push(power(m))
  }
  let lufs: number | null = null
  if (gated.length > 0) {
    const relGate = loudnessOf(gated.reduce((s, p) => s + p, 0) / gated.length) + RELATIVE_GATE_LU
    const relGatePower = power(relGate)
    const kept = gated.filter((p) => p > relGatePower)
    if (kept.length > 0) lufs = loudnessOf(kept.reduce((s, p) => s + p, 0) / kept.length)
  }

  // Peak: every step the window touches (a tiny epsilon keeps an exact grid
  // edge from pulling in the neighbouring step).
  const p0 = Math.max(0, Math.floor(a + 1e-6))
  const p1 = Math.min(peak.length - 1, Math.ceil(b - 1e-6) - 1)
  let peakDb: number | null = null
  for (let i = p0; i <= p1; i++) {
    const p = peak[i]
    if (p != null && (peakDb == null || p > peakDb)) peakDb = p
  }
  return { status: 'ok', lufs, peakDb }
}
