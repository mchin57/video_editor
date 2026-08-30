/**
 * Sparkles — the decorative particle layer of a text overlay's "Text effects",
 * and the SINGLE source of truth for where every sparkle sits and when it
 * twinkles, shared by the CSS preview and the ASS burn.
 *
 * The whole design turns on one constraint: **preview and export must agree
 * without either side measuring glyphs.** The preview could measure its DOM and
 * libass could measure its faces, but they would disagree, and neither can ask
 * the other. So placement is derived only from inputs BOTH sides already have —
 * the text, the font size, and the layer window — through the rough metrics
 * below. Sparkles land around the text rather than on exact glyph boxes, which
 * is all a decorative effect needs; nothing here should start depending on
 * measured text.
 *
 * Placement is pseudo-random but DETERMINISTIC: seeded from the text itself, so
 * the same overlay sparkles identically in the preview, in the export, and
 * across re-renders. Re-rendering a project must never reshuffle them.
 *
 * The ASS side emits one `\p1` vector-drawing event per sparkle at Layer 1
 * (above the glyphs), animated with `\fad` + `\t(\fscx\fscy)` + `\frz` — all
 * verified against ffmpeg 8.1.1, see docs/FFMPEG-NOTES.md "ASS animation tags".
 */

/** Sparkle appearance. Kept deliberately small — the shape and motion are
 *  fixed; only how many and what colour are exposed. */
export interface SparkleEffect {
  /** Roughly how busy the effect is, 1 (a few glints) .. 10 (a shower). */
  density: number
  /** Sparkle colour (hex). */
  color: string
}

/** Optional decorative effects on a text overlay, independent of its
 *  entrance/exit animation. Absent members are simply off. Add future effects
 *  (glow, shake, wave) here rather than as new entrance presets. */
export interface TextEffects {
  sparkle?: SparkleEffect | null
}

export const DEFAULT_SPARKLE: SparkleEffect = { density: 4, color: '#ffe08a' }
export const SPARKLE_DENSITY_RANGE = { min: 1, max: 10 } as const

/**
 * Density is expressed as **sparkles on screen at once**, not as a birth rate:
 * density 1 shows ~10 and density 10 shows ~100. That is the number anyone
 * actually looks at, and it stays put as the overlay gets longer (a rate would
 * make a 10s overlay look identical to a 2s one only by accident).
 */
export const CONCURRENT_PER_DENSITY = 10
/** Ceiling on how many sparkles may be alive at once, at any density. */
export const MAX_CONCURRENT_SPARKLES = 100
/**
 * Absolute cap on sparkles for one overlay. This is a FILE-SIZE guard, not a
 * visual one — each sparkle is its own ASS Dialogue event, so a very long,
 * very dense overlay would otherwise write a huge subtitle file. It only bites
 * past roughly 11s at maximum density; below that `MAX_CONCURRENT_SPARKLES` is
 * what shapes the look.
 */
export const MAX_SPARKLES = 2000
/** How long one sparkle takes to twinkle in and back out (seconds). */
export const SPARKLE_LIFE_SEC = 0.55
/** Sparkle radius as a fraction of the font size, min..max. */
export const SPARKLE_MIN_SCALE = 0.09
export const SPARKLE_MAX_SCALE = 0.2

// --- Rough text metrics (see the header: never measured, only estimated) -----

/** Mean glyph advance as a fraction of font size, across the bundled faces. */
export const AVG_CHAR_ADVANCE = 0.5
/** Line advance as a fraction of font size — matches the preview's
 *  `leading-tight` and libass's default line spacing closely enough. */
export const LINE_HEIGHT_RATIO = 1.15

/** The text's lines, as the estimate sees them (explicit breaks only — neither
 *  side can agree on where automatic wrapping would fall). */
export function textLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Estimated size of the text block in logical px. */
export function estimateTextBox(
  text: string,
  fontSizePx: number
): { width: number; height: number } {
  const lines = textLines(text)
  const cols = lines.reduce((m, l) => Math.max(m, l.length), 0)
  return {
    width: cols * AVG_CHAR_ADVANCE * fontSizePx,
    height: lines.length * LINE_HEIGHT_RATIO * fontSizePx
  }
}

/**
 * Estimated offset of character `index` from the CENTER of the text block, in
 * logical px — used to follow a typewriter's reveal frontier. Lines are treated
 * as centered, matching the overlay's centered layout.
 */
export function charAnchor(
  text: string,
  index: number,
  fontSizePx: number
): { x: number; y: number } {
  const lines = textLines(text)
  const box = estimateTextBox(text, fontSizePx)
  let remaining = Math.max(0, Math.min(index, text.length))
  for (let row = 0; row < lines.length; row++) {
    const len = lines[row].length
    if (remaining <= len || row === lines.length - 1) {
      const col = Math.min(remaining, len)
      const lineW = len * AVG_CHAR_ADVANCE * fontSizePx
      const lineTop = row * LINE_HEIGHT_RATIO * fontSizePx
      return {
        x: -lineW / 2 + col * AVG_CHAR_ADVANCE * fontSizePx,
        y: lineTop + (LINE_HEIGHT_RATIO * fontSizePx) / 2 - box.height / 2
      }
    }
    remaining -= len + 1 // + the newline
  }
  return { x: 0, y: 0 }
}

// --- Deterministic randomness ------------------------------------------------

/** FNV-1a over the string — a stable seed so sparkles never reshuffle. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 — small, fast, and identical on both sides. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One sparkle: where it sits relative to the text centre, when it twinkles. */
export interface Sparkle {
  /** Birth time in seconds from the layer's start. */
  tSec: number
  lifeSec: number
  /** Offset from the text block's centre, logical px. */
  x: number
  y: number
  /** Radius in logical px. */
  sizePx: number
  rotDeg: number
}

export interface SparkleLayout {
  effect: SparkleEffect
  text: string
  fontSizePx: number
  /** Length of the overlay's window, seconds. */
  durSec: number
  /**
   * Entrance length of a TYPEWRITER reveal, seconds, or 0 when the entrance is
   * anything else. Sparkles born inside this window follow the reveal frontier
   * so the effect reads as "each letter arrives in a puff"; after it (and for
   * every other entrance, including a plain fade) they scatter over the text.
   */
  typewriterSec?: number
}

/**
 * Every sparkle for one text overlay, ordered by birth time. Pure and
 * deterministic — the same inputs always give the same sparkles, which is what
 * lets the preview and the ASS burn agree without sharing any state.
 */
export function sparklesFor(o: SparkleLayout): Sparkle[] {
  const density = Math.max(
    SPARKLE_DENSITY_RANGE.min,
    Math.min(SPARKLE_DENSITY_RANGE.max, o.effect.density)
  )
  const dur = Math.max(0.01, o.durSec)
  // Work back from "how many are on screen at once" to how many to spawn: each
  // lives ~SPARKLE_LIFE_SEC, so holding `concurrent` alive across `dur` needs
  // that many lifetimes' worth of births.
  const concurrent = Math.min(MAX_CONCURRENT_SPARKLES, density * CONCURRENT_PER_DENSITY)
  const count = Math.min(
    MAX_SPARKLES,
    Math.max(1, Math.round((concurrent * dur) / SPARKLE_LIFE_SEC))
  )
  const box = estimateTextBox(o.text, o.fontSizePx)
  const typeSec = o.typewriterSec ?? 0
  // Sparkles ride slightly outside the text block so they frame the glyphs
  // rather than sitting on top of them.
  const padX = o.fontSizePx * 0.35
  const padY = o.fontSizePx * 0.3
  // The seed must use only RESOLUTION-INDEPENDENT inputs. The preview passes
  // `fontSizePx` in logical px and the export passes it pre-scaled to output px,
  // so seeding on it would hand the two sides different sparkles at any preset
  // that is not 1080x1920. Everything the seed omits still varies the layout,
  // because every offset below is a multiple of `fontSizePx`.
  const rand = mulberry32(hashSeed(`${o.text}|${density}|${dur.toFixed(2)}`))

  const out: Sparkle[] = []
  for (let i = 0; i < count; i++) {
    // Spread births evenly across the window with jitter, so the twinkle is
    // continuous rather than clumped.
    const tSec = Math.min(dur, ((i + rand()) / count) * dur)
    const life = SPARKLE_LIFE_SEC * (0.7 + rand() * 0.6)
    let x: number
    let y: number
    if (typeSec > 0 && tSec < typeSec) {
      // Follow the reveal frontier: sparkle at the character being typed.
      const frac = tSec / typeSec
      const anchor = charAnchor(o.text, Math.floor(frac * o.text.length), o.fontSizePx)
      x = anchor.x + (rand() - 0.5) * o.fontSizePx * 0.8
      y = anchor.y + (rand() - 0.5) * o.fontSizePx * 0.9
    } else {
      x = (rand() - 0.5) * (box.width + padX * 2)
      y = (rand() - 0.5) * (box.height + padY * 2)
    }
    out.push({
      tSec,
      lifeSec: life,
      x,
      y,
      sizePx: o.fontSizePx * (SPARKLE_MIN_SCALE + rand() * (SPARKLE_MAX_SCALE - SPARKLE_MIN_SCALE)),
      rotDeg: rand() * 90
    })
  }
  return out
}

/**
 * A sparkle's opacity and scale at time `t` (seconds from the layer start).
 * Twinkles up to full at mid-life and back down, so it pops rather than
 * cross-fading — the ASS side gets the same shape from `\fad` + `\t`.
 * Returns opacity 0 outside its life, which the preview uses to skip it.
 */
export function sparkleStateAt(s: Sparkle, t: number): { opacity: number; scale: number } {
  const local = t - s.tSec
  if (local < 0 || local > s.lifeSec) return { opacity: 0, scale: 0 }
  const half = s.lifeSec / 2
  const up = local <= half
  const frac = up ? local / half : 1 - (local - half) / half
  return { opacity: frac, scale: 0.4 + 0.6 * frac }
}

/** Whether an overlay actually draws sparkles. */
export function activeSparkle(effects: TextEffects | null | undefined): SparkleEffect | null {
  const s = effects?.sparkle
  return s && s.density > 0 ? s : null
}
