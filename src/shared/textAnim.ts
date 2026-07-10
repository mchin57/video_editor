/**
 * Text overlay entrance/exit animations — the SINGLE source of truth for their
 * timing and geometry, shared by the CSS preview (PreviewStage computes a state
 * per frame from the playhead) and the ASS export (assBuilder maps the same
 * constants onto \fad/\move/\t/\k tags, all verified against ffmpeg 8.1.1 —
 * see docs/FFMPEG-NOTES.md "ASS animation tags"). Every ramp here is LINEAR
 * because the ASS side (\fad, \move, \t without accel, \k) is linear — don't
 * add CSS easing on the preview side without changing the burn to match.
 */

export type TextAnimIn = 'none' | 'fadeIn' | 'slideUp' | 'typewriter' | 'bounce' | 'wordHighlight'
export type TextAnimOut = 'none' | 'fadeOut' | 'slideDown'

export interface TextAnimation {
  in: TextAnimIn
  /** Entrance duration (seconds). Ignored by `wordHighlight`, which spans the
   *  overlay's whole window ("each word lights as it's spoken"). */
  inSec: number
  out: TextAnimOut
  outSec: number
}

/** Sensible per-preset entrance durations (seeded into the field on selection). */
export const DEFAULT_IN_SEC: Record<TextAnimIn, number> = {
  none: 0.3,
  fadeIn: 0.3,
  slideUp: 0.35,
  typewriter: 1.2,
  bounce: 0.45,
  wordHighlight: 0.3
}
export const DEFAULT_OUT_SEC = 0.3

/** Slide travel in logical px (slideUp enters from below; slideDown exits down). */
export const SLIDE_DIST_PX = 90
/** Bounce: scale ramps 0.3 → 1.1 (overshoot at 60% of the entrance) → 1. */
export const BOUNCE_START_SCALE = 0.3
export const BOUNCE_OVERSHOOT_SCALE = 1.1
export const BOUNCE_OVERSHOOT_FRAC = 0.6
/** Bounce/slide pair their motion with a short/full linear fade-in. */
export const BOUNCE_FADE_SEC = 0.12
/** Un-highlighted karaoke words render at this opacity (ASS `\2a&H99&` ≈ 0.4). */
export const KARAOKE_DIM_OPACITY = 0.4
/** Cap on typewriter reveal steps (long texts reveal in chunks, not per char). */
export const TYPEWRITER_MAX_STEPS = 60

/** The animation the render pipeline actually honors: none when the overlay
 *  burns as a rasterised PNG (gradient fill or explicit wrap width — the PNG
 *  compositor can't animate it), so preview and export stay in lockstep. */
export function effectiveTextAnimation(content: {
  animation?: TextAnimation | null
  gradient?: unknown
  widthPx?: number | null
}): TextAnimation | null {
  const a = content.animation
  if (!a || (a.in === 'none' && a.out === 'none')) return null
  if (content.gradient || content.widthPx != null) return null
  return a
}

/** Entrance/exit windows clamped to the overlay duration: when they'd overlap,
 *  both scale down proportionally so in+out never exceeds the window. */
export function clampAnimWindows(
  anim: TextAnimation,
  durSec: number
): { inSec: number; outSec: number } {
  const wantIn = anim.in === 'none' ? 0 : Math.max(0.01, anim.inSec)
  const wantOut = anim.out === 'none' ? 0 : Math.max(0.01, anim.outSec)
  const sum = wantIn + wantOut
  if (sum <= durSec || sum === 0) return { inSec: wantIn, outSec: wantOut }
  const k = durSec / sum
  return { inSec: wantIn * k, outSec: wantOut * k }
}

/** Non-whitespace tokens of the text, in order (karaoke units). */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0)
}

/** Typewriter reveal boundaries: cumulative character counts per step (the last
 *  step always shows everything). Long texts reveal in chunks so the ASS side
 *  never emits more than TYPEWRITER_MAX_STEPS events. */
export function typewriterSteps(textLen: number, maxSteps = TYPEWRITER_MAX_STEPS): number[] {
  if (textLen <= 0) return []
  const chunk = Math.max(1, Math.ceil(textLen / maxSteps))
  const steps: number[] = []
  for (let c = chunk; c < textLen; c += chunk) steps.push(c)
  steps.push(textLen)
  return steps
}

/** Per-frame animation state for the preview (all ramps linear; see header). */
export interface TextAnimState {
  /** 0..1 multiplier. */
  opacity: number
  /** Vertical offset in logical px (positive = down). */
  dy: number
  /** Scale multiplier on top of the layer's own scale. */
  scale: number
  /** Characters currently revealed (typewriter), or null (all visible). */
  revealChars: number | null
  /** Words currently lit (wordHighlight), or null (no karaoke). */
  litWords: number | null
}

const IDLE: TextAnimState = { opacity: 1, dy: 0, scale: 1, revealChars: null, litWords: null }

/**
 * Animation state of a text overlay at timeline time `t`. Pure — the preview
 * calls it every frame with the playhead so scrubbing/pausing stay exact
 * (never CSS animations, which run on wall time).
 */
export function textAnimStateAt(
  anim: TextAnimation | null | undefined,
  startSec: number,
  endSec: number,
  text: string,
  t: number
): TextAnimState {
  if (!anim || (anim.in === 'none' && anim.out === 'none')) return IDLE
  const dur = Math.max(0.01, endSec - startSec)
  const local = Math.min(Math.max(0, t - startSec), dur)
  const { inSec, outSec } = clampAnimWindows(anim, dur)
  const st: TextAnimState = { ...IDLE }

  const inFrac = inSec > 0 ? Math.min(1, local / inSec) : 1
  switch (anim.in) {
    case 'fadeIn':
      st.opacity = inFrac
      break
    case 'slideUp':
      st.opacity = inFrac
      st.dy = SLIDE_DIST_PX * (1 - inFrac)
      break
    case 'bounce': {
      st.opacity = Math.min(1, BOUNCE_FADE_SEC > 0 ? local / BOUNCE_FADE_SEC : 1)
      if (inFrac < BOUNCE_OVERSHOOT_FRAC) {
        const f = inFrac / BOUNCE_OVERSHOOT_FRAC
        st.scale = BOUNCE_START_SCALE + (BOUNCE_OVERSHOOT_SCALE - BOUNCE_START_SCALE) * f
      } else {
        const f = (inFrac - BOUNCE_OVERSHOOT_FRAC) / (1 - BOUNCE_OVERSHOOT_FRAC)
        st.scale = BOUNCE_OVERSHOOT_SCALE + (1 - BOUNCE_OVERSHOOT_SCALE) * f
      }
      break
    }
    case 'typewriter': {
      const steps = typewriterSteps(text.length)
      if (steps.length > 0 && local < inSec) {
        const stepDur = inSec / steps.length
        st.revealChars = steps[Math.min(steps.length - 1, Math.floor(local / stepDur))]
      }
      break
    }
    case 'wordHighlight': {
      // Spans the whole window; a word lights at the START of its interval
      // (matches ASS \k — verified). A slideDown exit gets its own ASS event,
      // so the karaoke window shortens by outSec on both sides to stay in sync.
      const n = splitWords(text).length
      if (n > 0) {
        const win = anim.out === 'slideDown' ? Math.max(0.01, dur - outSec) : dur
        const wordDur = win / n
        st.litWords = Math.min(n, Math.floor(local / wordDur) + 1)
      }
      break
    }
  }

  const untilEnd = dur - local
  if (outSec > 0 && untilEnd < outSec) {
    const outFrac = Math.max(0, untilEnd / outSec) // 1 → 0 across the exit
    if (anim.out === 'fadeOut') st.opacity *= outFrac
    else if (anim.out === 'slideDown') {
      st.opacity *= outFrac
      st.dy += SLIDE_DIST_PX * (1 - outFrac)
    }
  }
  return st
}
