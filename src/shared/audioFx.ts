/**
 * Audio effect model for GENERATED EFFECT TRACKS — the single source of truth
 * for what an echo, an ensemble or a chorus is, shared by the Inspector
 * (labels, ranges, defaults) and the renderer service that turns one into
 * ffmpeg args (`main/services/audioFx.ts`).
 *
 * An effect is an ADDITION: the render produces the **wet signal only**, which
 * lands on the timeline as its own `AudioClip` mixed on top of the untouched
 * dry clip. Nothing here modifies the source. That is what keeps preview and
 * export identical — an effect track is an ordinary audio asset playing through
 * the ordinary `<audio>` follower, so the preview is not a model of the export,
 * it is the same samples.
 *
 * Every recipe these numbers feed is verified against the real binary — see
 * docs/FFMPEG-NOTES.md "Audio effects". In particular `aecho` has NO feedback
 * (N repeats must be emitted as N explicit taps) and ffmpeg's own `chorus`
 * filter is unusable, so both stacking effects are built from primitives.
 */

export type AudioFxKind = 'echo' | 'ensemble' | 'chorus'

/**
 * Repeating echo. `decay` is the level of the FIRST repeat relative to the dry
 * signal; each later repeat multiplies by it again, so the tail falls off
 * geometrically (see `echoTaps`).
 */
export interface EchoEffect {
  /** Delay of the first repeat, ms. Later repeats are multiples of it. */
  delayMs: number
  /** Level of the first repeat, 0..1. */
  decay: number
  /** How many repeats to emit. */
  repeats: number
}

/**
 * ENSEMBLE: N copies of the sound, each offset in time by a FIXED amount,
 * detuned by a FIXED amount, and at its own level — a doubled/stacked voice.
 *
 * This is not a chorus: the detune sits still rather than sweeping. It is the
 * "several takes at once" thickening, which is what you want under a spoken
 * line. For the swept shimmer, see `ChorusEffect`.
 */
export interface EnsembleEffect {
  /** How many copies. */
  voices: number
  /** Timing spread, ms — the last voice sits this far behind the dry signal. */
  spreadMs: number
  /** Maximum detune in cents; voices alternate sharp/flat around the source. */
  detuneCents: number
}

/**
 * CHORUS: N copies whose delay is continuously swept by an LFO, so each voice's
 * pitch drifts sharp and flat around the source instead of sitting at a fixed
 * offset. That movement is what people recognise as "chorus" — the shimmer a
 * chorus pedal produces — as opposed to the static stacking of an ensemble.
 *
 * Each voice gets a slightly different sweep rate: ffmpeg's `vibrato` has no
 * phase control, so differing rates are what stop the voices from moving in
 * lockstep and collapsing into one.
 */
export interface ChorusEffect {
  /** How many swept copies. */
  voices: number
  /** Sweep speed, Hz (how fast the pitch drifts back and forth). */
  rateHz: number
  /** Sweep amount, 0..1 — how far the pitch drifts. 1 is about ±54 cents. */
  depth: number
}

/** The parameters of one effect, discriminated by kind. */
export type AudioFxSettings =
  | { kind: 'echo'; echo: EchoEffect }
  | { kind: 'ensemble'; ensemble: EnsembleEffect }
  | { kind: 'chorus'; chorus: ChorusEffect }

/**
 * Provenance stamped on a generated effect clip (`AudioClip.fx`). Records what
 * the wet signal was rendered FROM so the Inspector can re-edit the settings
 * and re-render, and so the timeline can badge the clip as an effect track.
 * Ordinary audio clips have no `fx`.
 */
export interface AudioFx {
  settings: AudioFxSettings
  /** Media the wet signal was rendered from. */
  fromMediaId: string
  /** Source window the render captured. */
  fromInSec: number
  fromOutSec: number
}

export const DEFAULT_ECHO: EchoEffect = { delayMs: 260, decay: 0.45, repeats: 3 }
export const DEFAULT_ENSEMBLE: EnsembleEffect = { voices: 3, spreadMs: 32, detuneCents: 14 }
export const DEFAULT_CHORUS: ChorusEffect = { voices: 3, rateHz: 1.2, depth: 0.35 }

/** Inclusive UI ranges. Kept here so the Inspector and the clamps agree. */
export const ECHO_RANGE = {
  delayMs: { min: 40, max: 1200 },
  decay: { min: 0.05, max: 0.9 },
  repeats: { min: 1, max: 6 }
} as const
export const ENSEMBLE_RANGE = {
  voices: { min: 2, max: 5 },
  spreadMs: { min: 8, max: 80 },
  detuneCents: { min: 2, max: 50 }
} as const
export const CHORUS_RANGE = {
  voices: { min: 2, max: 4 },
  // `vibrato` accepts from 0.1 Hz; below ~0.2 the movement stops reading as one.
  rateHz: { min: 0.2, max: 6 },
  depth: { min: 0.05, max: 1 }
} as const

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const clampInt = (n: number, lo: number, hi: number): number => clamp(Math.round(n), lo, hi)

/** Clamp user input to the supported range (also guards a hand-edited project). */
export function normalizeEcho(e: EchoEffect): EchoEffect {
  return {
    delayMs: clamp(e.delayMs, ECHO_RANGE.delayMs.min, ECHO_RANGE.delayMs.max),
    decay: clamp(e.decay, ECHO_RANGE.decay.min, ECHO_RANGE.decay.max),
    repeats: clampInt(e.repeats, ECHO_RANGE.repeats.min, ECHO_RANGE.repeats.max)
  }
}

export function normalizeEnsemble(e: EnsembleEffect): EnsembleEffect {
  return {
    voices: clampInt(e.voices, ENSEMBLE_RANGE.voices.min, ENSEMBLE_RANGE.voices.max),
    spreadMs: clamp(e.spreadMs, ENSEMBLE_RANGE.spreadMs.min, ENSEMBLE_RANGE.spreadMs.max),
    detuneCents: clamp(
      e.detuneCents,
      ENSEMBLE_RANGE.detuneCents.min,
      ENSEMBLE_RANGE.detuneCents.max
    )
  }
}

export function normalizeChorus(c: ChorusEffect): ChorusEffect {
  return {
    voices: clampInt(c.voices, CHORUS_RANGE.voices.min, CHORUS_RANGE.voices.max),
    rateHz: clamp(c.rateHz, CHORUS_RANGE.rateHz.min, CHORUS_RANGE.rateHz.max),
    depth: clamp(c.depth, CHORUS_RANGE.depth.min, CHORUS_RANGE.depth.max)
  }
}

/** Quietest echo repeat worth rendering (-60 dB). */
export const ECHO_MIN_TAP_GAIN = 0.001

/** One repeat of an echo: when it lands and how loud it is. */
export interface EchoTap {
  delayMs: number
  gain: number
}

/**
 * The explicit taps for a repeating echo. `aecho` taps the INPUT with no
 * feedback (verified — FFMPEG-NOTES), so a decaying tail is N taps at multiples
 * of `delayMs` with geometrically falling gains, NOT one tap fed back on itself.
 */
export function echoTaps(e: EchoEffect): EchoTap[] {
  const { delayMs, decay, repeats } = normalizeEcho(e)
  const taps: EchoTap[] = []
  for (let i = 1; i <= repeats; i++) {
    const gain = Math.pow(decay, i)
    // A geometric tail reaches inaudibility fast at low decay (0.05^4 is -104
    // dB). Stop there rather than emitting taps nothing can hear — it also
    // keeps `fxTailSec` honest about where the effect actually stops sounding.
    if (gain < ECHO_MIN_TAP_GAIN && taps.length > 0) break
    taps.push({ delayMs: delayMs * i, gain })
  }
  return taps
}

/** Level of the first (loudest) stacked voice; later voices step down from it. */
export const VOICE_LEAD_GAIN = 0.55
/** Per-voice level falloff, so the copies sit at slightly different volumes. */
export const VOICE_GAIN_STEP = 0.12

/** Level of voice `i` in a stack — shared by ensemble and chorus. */
function voiceGain(i: number): number {
  return VOICE_LEAD_GAIN * (1 - i * VOICE_GAIN_STEP)
}

/** One copy in an ensemble: its offset, its (fixed) detune, and its level. */
export interface EnsembleVoice {
  delayMs: number
  /** Detune in cents; positive is sharp. */
  cents: number
  gain: number
}

/**
 * The copies making up an ensemble. Voices fan out evenly across `spreadMs`,
 * alternate sharp/flat with the detune growing toward the outermost voice, and
 * step down in level — different tones, volumes and timings, held STILL.
 */
export function ensembleVoices(e: EnsembleEffect): EnsembleVoice[] {
  const { voices, spreadMs, detuneCents } = normalizeEnsemble(e)
  const out: EnsembleVoice[] = []
  for (let i = 0; i < voices; i++) {
    const frac = (i + 1) / voices
    out.push({
      delayMs: spreadMs * frac,
      cents: detuneCents * frac * (i % 2 === 0 ? 1 : -1),
      gain: voiceGain(i)
    })
  }
  return out
}

/** Base delay of a chorus voice, ms — enough separation to read as a doubled
 *  voice rather than a flange. */
export const CHORUS_BASE_DELAY_MS = 18
/** Extra static delay per additional chorus voice, ms. */
export const CHORUS_VOICE_DELAY_STEP_MS = 7
/** Per-voice sweep-rate spread. `vibrato` has no phase control, so each voice
 *  is given a slightly faster LFO instead; without this they move in lockstep
 *  and collapse into a single wobble. */
export const CHORUS_RATE_SPREAD = 0.18

/** One swept copy in a chorus: how fast it drifts, where it sits, how loud. */
export interface ChorusVoice {
  /** This voice's own LFO rate, Hz. */
  rateHz: number
  /** Static delay before the swept copy, ms. */
  delayMs: number
  gain: number
}

/**
 * The swept copies making up a chorus. Each voice sits a little further back
 * and sweeps a little faster than the last, so they drift independently.
 */
export function chorusVoices(c: ChorusEffect): ChorusVoice[] {
  const { voices, rateHz } = normalizeChorus(c)
  const out: ChorusVoice[] = []
  for (let i = 0; i < voices; i++) {
    out.push({
      rateHz: rateHz * (1 + i * CHORUS_RATE_SPREAD),
      delayMs: CHORUS_BASE_DELAY_MS + i * CHORUS_VOICE_DELAY_STEP_MS,
      gain: voiceGain(i)
    })
  }
  return out
}

/**
 * How much LONGER the wet signal runs than its source: the last tap/voice is
 * still sounding after the dry has stopped. `aecho` and `adelay` both extend
 * the stream by their longest delay (verified), so an effect clip's timeline
 * block is this much longer than the clip it came from.
 */
export function fxTailSec(settings: AudioFxSettings): number {
  const last = <T extends { delayMs: number }>(xs: T[]): number =>
    xs.length === 0 ? 0 : xs[xs.length - 1].delayMs / 1000
  if (settings.kind === 'echo') return last(echoTaps(settings.echo))
  if (settings.kind === 'ensemble') return last(ensembleVoices(settings.ensemble))
  return last(chorusVoices(settings.chorus))
}

/** Short human label for an effect track (clip name, timeline badge). */
export function fxLabel(settings: AudioFxSettings): string {
  if (settings.kind === 'echo') return 'Echo'
  return settings.kind === 'ensemble' ? 'Ensemble' : 'Chorus'
}

/** The default settings for a kind — what "Add <effect>" starts from. */
export function defaultFxSettings(kind: AudioFxKind): AudioFxSettings {
  if (kind === 'echo') return { kind: 'echo', echo: { ...DEFAULT_ECHO } }
  if (kind === 'ensemble') return { kind: 'ensemble', ensemble: { ...DEFAULT_ENSEMBLE } }
  return { kind: 'chorus', chorus: { ...DEFAULT_CHORUS } }
}
