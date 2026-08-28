/**
 * Renders an audio effect (echo / chorus) to a standalone WET-ONLY asset — the
 * "add sound effect" pipeline. The result is imported as an ordinary library
 * asset and dropped on the timeline as its own `AudioClip`, mixed on top of the
 * untouched dry clip. Nothing about the source is modified.
 *
 * Rendering to a real file (rather than resolving the effect at export time) is
 * what makes preview and export agree by construction: the preview plays the
 * very samples the export will mix, through the ordinary `<audio>` follower.
 * It also means the timeline draws the effect's own waveform, and gain / fades
 * / trim / split all work on it with no new code.
 *
 * The recipes are verified against the real binary — see docs/FFMPEG-NOTES.md
 * "Audio effects — echo & chorus". Two findings shape this file: `aecho` has no
 * feedback (so repeats are explicit taps), and ffmpeg's own `chorus` filter
 * IGNORES its `delays`, so chorus is assembled from asplit / asetrate /
 * aresample / atempo / volume / adelay / amix instead.
 *
 * Arg builders here are pure and unit-tested; `renderAudioFx` runs them.
 */

import type { AudioFxSettings } from '@shared/audioFx'
import { chorusVoices, echoTaps } from '@shared/audioFx'
import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'

/** Working rate for the effect graph. The pitch-shift stages derive their
 *  `atempo` from this, so the chain must actually be at this rate — hence the
 *  `aformat` before any voice splitting. */
export const FX_SAMPLE_RATE = 48000

const f3 = (n: number): string => n.toFixed(3)

/**
 * Pitch-shift stages for one chorus voice: reinterpret the samples at a shifted
 * rate (raising pitch and shortening the voice), resample back to the working
 * rate, then undo the duration change with `atempo` — leaving pitch moved and
 * length intact. The shifted rate is ROUNDED TO AN INTEGER and `atempo` derived
 * from the rounded value, or the two stages disagree and the voice drifts out
 * of sync with its siblings (verified — FFMPEG-NOTES).
 */
export function pitchStages(cents: number, rate = FX_SAMPLE_RATE): string[] {
  const shifted = Math.round(rate * Math.pow(2, cents / 1200))
  if (shifted === rate) return []
  return [`asetrate=${shifted}`, `aresample=${rate}`, `atempo=${(rate / shifted).toFixed(6)}`]
}

/** Trim + normalise the source window every effect graph starts from. */
function sourceChain(inSec: number, outSec: number): string {
  return [
    `atrim=${f3(inSec)}:${f3(outSec)}`,
    'asetpts=N/SR/TB',
    `aformat=sample_fmts=fltp:sample_rates=${FX_SAMPLE_RATE}:channel_layouts=stereo`
  ].join(',')
}

/**
 * The wet-only `filter_complex` for one effect, ending at `[fx]`.
 *
 * Echo is a single `aecho` with `in_gain=0` (which drops the dry signal
 * entirely) and one explicit tap per repeat. Chorus splits the source into one
 * branch per voice — each detuned, levelled and delayed — and mixes them with
 * `normalize=0` so the per-voice gains are the gains that actually land.
 *
 * Every `adelay` is followed by `asetpts=N/SR/TB`: an `atrim`'d stream fed into
 * a non-zero `adelay` emits a poisoned near-INT64_MAX PTS that kills the mux
 * far downstream (verified — FFMPEG-NOTES "adelay after atrim").
 */
export function buildAudioFxFilter(
  settings: AudioFxSettings,
  inSec: number,
  outSec: number
): string {
  const src = sourceChain(inSec, outSec)

  if (settings.kind === 'echo') {
    const taps = echoTaps(settings.echo)
    const delays = taps.map((t) => Math.round(t.delayMs)).join('|')
    const decays = taps.map((t) => t.gain.toFixed(4)).join('|')
    // in_gain=0 => wet only; out_gain=1 => the taps land at exactly their decays.
    return `[0:a]${src},aecho=0:1:${delays}:${decays}[fx]`
  }

  const voices = chorusVoices(settings.chorus)
  const chains: string[] = [`[0:a]${src}[src]`]
  chains.push(`[src]asplit=${voices.length}${voices.map((_, i) => `[v${i}]`).join('')}`)
  voices.forEach((v, i) => {
    const parts = [
      ...pitchStages(v.cents),
      `volume=${v.gain.toFixed(4)}`,
      `adelay=${Math.round(v.delayMs)}:all=1`,
      'asetpts=N/SR/TB'
    ]
    chains.push(`[v${i}]${parts.join(',')}[o${i}]`)
  })
  chains.push(
    `${voices.map((_, i) => `[o${i}]`).join('')}amix=inputs=${voices.length}:normalize=0[fx]`
  )
  return chains.join(';')
}

/** Full ffmpeg args rendering the wet signal to a lossless WAV — the same
 *  format `buildExtractAudioArgs` produces, so the normal import pipeline picks
 *  it up and builds the AAC proxy + waveform for it. */
export function buildAudioFxArgs(
  settings: AudioFxSettings,
  input: string,
  inSec: number,
  outSec: number,
  output: string
): string[] {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-i', input,
    '-filter_complex', buildAudioFxFilter(settings, inSec, outSec),
    '-map', '[fx]',
    '-c:a', 'pcm_s16le', '-ar', String(FX_SAMPLE_RATE), '-ac', '2',
    output
  ]
}

/** Render an effect's wet signal from `input`'s [inSec, outSec) to `output`. */
export async function renderAudioFx(
  settings: AudioFxSettings,
  input: string,
  inSec: number,
  outSec: number,
  output: string
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await runFfmpeg(ffmpeg, buildAudioFxArgs(settings, input, inSec, outSec, output), 0)
}
