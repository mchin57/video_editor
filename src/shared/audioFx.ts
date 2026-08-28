/**
 * Audio effect model for GENERATED EFFECT TRACKS — the single source of truth
 * for what an echo or a chorus is, shared by the Inspector (labels, ranges,
 * defaults) and the renderer service that turns one into ffmpeg args
 * (`main/services/audioFx.ts`).
 *
 * An effect is an ADDITION: the render produces the **wet signal only**, which
 * lands on the timeline as its own `AudioClip` mixed on top of the untouched
 * dry clip. Nothing here modifies the source. That is what keeps preview and
 * export identical — an effect track is an ordinary audio asset playing through
 * the ordinary `<audio>` follower, so the preview is not a model of the export,
 * it is the same samples.
 *
 * Every recipe these numbers feed is verified against the real binary — see
 * docs/FFMPEG-NOTES.md "Audio effects — echo & chorus". In particular `aecho`
 * has NO feedback (N repeats must be emitted as N explicit taps) and ffmpeg's
 * own `chorus` filter is unusable, so chorus is built from primitives.
 */

export type AudioFxKind = 'echo' | 'chorus'

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
 * Chorus: N copies of the sound, each slightly offset in time, detuned, and at
 * its own level — close enough together to read as one thickened voice rather
 * than as separate echoes.
 */
export interface ChorusEffect {
  /** How many copies. */
  voices: number
  /** Timing spread, ms — the last voice sits this far behind the dry signal. */
  spreadMs: number
  /** Maximum detune in cents; voices alternate sharp/flat around the source. */
  detuneCents: number
}

/** The parameters of one effect, discriminated by kind. */
export type AudioFxSettings =
  | { kind: 'echo'; echo: EchoEffect }
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
export const DEFAULT_CHORUS: ChorusEffect = { voices: 3, spreadMs: 32, detuneCents: 14 }

/** Inclusive UI ranges. Kept here so the Inspector and the clamps agree. */
export const ECHO_RANGE = {
  delayMs: { min: 40, max: 1200 },
  decay: { min: 0.05, max: 0.9 },
  repeats: { min: 1, max: 6 }
} as const
export const CHORUS_RANGE = {
  voices: { min: 2, max: 5 },
  spreadMs: { min: 8, max: 80 },
  detuneCents: { min: 2, max: 50 }
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

export function normalizeChorus(c: ChorusEffect): ChorusEffect {
  return {
    voices: clampInt(c.voices, CHORUS_RANGE.voices.min, CHORUS_RANGE.voices.max),
    spreadMs: clamp(c.spreadMs, CHORUS_RANGE.spreadMs.min, CHORUS_RANGE.spreadMs.max),
    detuneCents: clamp(c.detuneCents, CHORUS_RANGE.detuneCents.min, CHORUS_RANGE.detuneCents.max)
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

/** One copy in a chorus: its offset, its detune, and its level. */
export interface ChorusVoice {
  delayMs: number
  /** Detune in cents; positive is sharp. */
  cents: number
  gain: number
}

/** Level of the first (loudest) chorus voice; later voices step down from it. */
export const CHORUS_LEAD_GAIN = 0.55
/** Per-voice level falloff, so the copies sit at slightly different volumes. */
export const CHORUS_GAIN_STEP = 0.12

/**
 * The copies making up a chorus. Voices fan out evenly across `spreadMs`,
 * alternate sharp/flat with the detune growing toward the outermost voice, and
 * step down in level — "slightly different tones, volumes and timings", while
 * staying close enough to fuse into one voice.
 */
export function chorusVoices(c: ChorusEffect): ChorusVoice[] {
  const { voices, spreadMs, detuneCents } = normalizeChorus(c)
  const out: ChorusVoice[] = []
  for (let i = 0; i < voices; i++) {
    const frac = (i + 1) / voices
    out.push({
      delayMs: spreadMs * frac,
      cents: detuneCents * frac * (i % 2 === 0 ? 1 : -1),
      gain: CHORUS_LEAD_GAIN * (1 - i * CHORUS_GAIN_STEP)
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
  if (settings.kind === 'echo') {
    const taps = echoTaps(settings.echo)
    return taps.length === 0 ? 0 : taps[taps.length - 1].delayMs / 1000
  }
  const voices = chorusVoices(settings.chorus)
  return voices.length === 0 ? 0 : voices[voices.length - 1].delayMs / 1000
}

/** Short human label for an effect track (clip name, timeline badge). */
export function fxLabel(settings: AudioFxSettings): string {
  return settings.kind === 'echo' ? 'Echo' : 'Chorus'
}

/** The default settings for a kind — what "Add echo"/"Add chorus" starts from. */
export function defaultFxSettings(kind: AudioFxKind): AudioFxSettings {
  return kind === 'echo'
    ? { kind: 'echo', echo: { ...DEFAULT_ECHO } }
    : { kind: 'chorus', chorus: { ...DEFAULT_CHORUS } }
}
