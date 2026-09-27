/**
 * PURE generator for an ASS subtitle file that burns the project's text overlays
 * and captions into the export. PlayResX/Y match the OUTPUT size (the exporter
 * pre-scales all geometry to output px), so what you positioned in the preview is
 * what burns.
 *
 * Two base styles: "Plain"/"Caption" (text + outline for legibility) and "Pill"
 * (BorderStyle=3 opaque box behind the text). Per-overlay font, position, size,
 * colour, stroke and shadow are inline tags. The font name (`\fn`) is resolved
 * from the bundled-font catalog (shared/fonts); the matching faces are handed to
 * libass via `fontsdir` (see exporterArgs). Gradient-filled text does NOT come
 * through here — it's rendered to a PNG and composited (ASS has no gradients).
 */

import type { CaptionsConfig, PillStyle, ShadowStyle, StrokeStyle } from '@shared/project'
import { resolveFont } from '@shared/fonts'
import {
  BOUNCE_FADE_SEC,
  BOUNCE_OVERSHOOT_FRAC,
  BOUNCE_OVERSHOOT_SCALE,
  BOUNCE_START_SCALE,
  clampAnimWindows,
  SLIDE_DIST_PX,
  splitWords,
  typewriterSteps,
  type TextAnimation
} from '@shared/textAnim'
import type { Target } from './exporterArgs'

/** A resolved text overlay to burn (geometry in logical/output px). */
export interface AssOverlay {
  text: string
  startSec: number
  endSec: number
  x: number
  y: number
  anchor: 'center' | 'topLeft'
  /** Bundled-font id (shared/fonts) — resolved to a libass `\fn` name here. */
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
  /** Outline (output px). Ignored when `pill.enabled`. Absent = style default. */
  stroke?: StrokeStyle | null
  /** Drop shadow (output px). Absent = style default. */
  shadow?: ShadowStyle | null
  /** Entrance/exit animation (already resolved via `effectiveTextAnimation` —
   *  gradient/wrapped text never reaches this builder). Mapped onto
   *  \fad/\move/\t/\k and, for typewriter, per-step reveal events; every tag
   *  verified against ffmpeg 8.1.1 (docs/FFMPEG-NOTES.md "ASS animation tags"). */
  animation?: TextAnimation | null
  /** Decorative sparkles burned ABOVE the glyphs. Unlike `animation`, these are
   *  independent of how the text itself renders, so a gradient/wrapped overlay
   *  (which burns as a PNG) still gets them — the exporter emits a
   *  sparkle-only overlay in that case, with `text` empty. @see shared/sparkle.ts */
  sparkles?: AssSparkle[]
  /** Sparkle fill colour; defaults to white. */
  sparkleColor?: string
}

/** One sparkle to burn, already resolved to absolute time and OUTPUT px. */
export interface AssSparkle {
  startSec: number
  endSec: number
  /** Centre in output px. */
  x: number
  y: number
  /** Radius in output px at full size. */
  sizePx: number
  rotDeg: number
}

function assTime(sec: number): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const cs = Math.round((t - Math.floor(t)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** #RGB/#RGBA/#RRGGBB/#RRGGBBAA → ASS &HAABBGGRR (ASS alpha: 00 opaque, FF
 *  transparent). Malformed input falls back to opaque white rather than
 *  emitting a garbage tag libass would choke on. */
export function assColor(hex: string): string {
  let h = hex.replace('#', '').trim()
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('') // shorthand → full
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return '&H00FFFFFF'
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  const cssAlpha = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255
  const assAlpha = (255 - cssAlpha).toString(16).padStart(2, '0')
  return `&H${assAlpha}${b}${g}${r}`.toUpperCase()
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/** `\fn…\b…` — the resolved font face + its bold flag (all bundled faces b0). */
function fontTags(fontFamilyId: string): string {
  const def = resolveFont(fontFamilyId)
  return `\\fn${def.assName}\\b${def.assBold}`
}

/**
 * Stroke + shadow inline tags shared by overlays and captions. Stroke maps to
 * `\bord`/`\3c` (BorderStyle 1) and is skipped when a pill is on, because the
 * Pill style (BorderStyle 3) repurposes those same tags for the opaque box.
 * Shadow maps to `\shad`/`\4c` (+`\blur`) and applies in both modes.
 */
function decoTags(pillEnabled: boolean, stroke?: StrokeStyle | null, shadow?: ShadowStyle | null): string {
  const tags: string[] = []
  if (!pillEnabled && stroke) {
    tags.push(`\\bord${f1(Math.max(0, stroke.widthPx))}`, `\\3c${assColor(stroke.color)}&`)
  }
  if (shadow) {
    tags.push(`\\shad${f1(Math.max(0, shadow.distancePx))}`, `\\4c${assColor(shadow.color)}&`)
    if (shadow.blur > 0) tags.push(`\\blur${f1(shadow.blur)}`)
  }
  return tags.join('')
}

/**
 * `pxScale` is output px per logical px (`frameToOutput(...).s`) — the one
 * length this builder derives itself, the slide-animation travel, is a logical
 * constant. Every built-in format renders 1:1, hence the default.
 */
export function buildAss(
  overlays: AssOverlay[],
  target: Target,
  captions?: CaptionsConfig | null,
  pxScale = 1
): string {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${target.width}`,
    `PlayResY: ${target.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Bold=0: bundled faces carry their own weight (no libass faux-bold). Each
    // overlay overrides Fontname via an inline \fn tag.
    'Style: Plain,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,1,5,0,0,0,1',
    'Style: Pill,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,18,0,5,0,0,0,1',
    'Style: Caption,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,5,1,5,0,0,0,1',
    // Sparkles are \p1 vector drawings, not glyphs: no outline, no shadow, and
    // centre-anchored so \pos places the sparkle's middle.
    'Style: Sparkle,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  // Captions (auto-generated): each rendered with its effective style — the
  // per-segment override if present, else the lane-wide style. Geometry arrives
  // already scaled to output px (the exporter pre-scales). A gradient-filled
  // caption is rendered to a PNG instead and never reaches this builder.
  if (captions?.enabled) {
    const r = (n: number): number => Math.round(n)
    for (const seg of captions.segments) {
      if (!seg.enabled || seg.text.trim().length === 0) continue
      const st = seg.style ?? captions.style
      if (st.gradient) continue // burned as a PNG overlay by the exporter
      const styleName = st.pill.enabled ? 'Pill' : 'Caption'
      const tags = [
        `\\an5`,
        `\\pos(${r(st.x)},${r(st.y)})`,
        fontTags(st.fontFamily),
        `\\fs${r(st.fontSizePx)}`,
        `\\c${assColor(st.color)}&`
      ]
      // ASS rotation is counter-clockwise positive; our rotationDeg is clockwise.
      if (st.rotationDeg) tags.push(`\\frz${(-st.rotationDeg).toFixed(0)}`)
      if (st.pill.enabled) tags.push(`\\3c${assColor(st.pill.color)}&`, `\\bord${r(st.pill.padPx)}`)
      const deco = decoTags(st.pill.enabled, st.stroke, st.shadow)
      if (deco) tags.push(deco)
      lines.push(
        `Dialogue: 0,${assTime(seg.startSec)},${assTime(seg.endSec)},${styleName},,0,0,0,,{${tags.join('')}}${escapeText(seg.text)}`
      )
    }
  }

  for (const o of overlays) {
    // A sparkle-only overlay (empty text) is legitimate: it carries the
    // decoration for text that burned as a PNG on the image track.
    if (o.text.trim().length === 0 && !o.sparkles?.length) continue
    lines.push(...overlayEvents(o, pxScale))
  }

  return lines.join('\n') + '\n'
}

/** The unit sparkle: a four-point star of radius 10 in `\p1` drawing units,
 *  scaled to size with `\fscx`/`\fscy` like a glyph (verified — FFMPEG-NOTES). */
const SPARKLE_PATH = 'm 0 -10 l 2 -2 l 10 0 l 2 2 l 0 10 l -2 2 l -10 0 l -2 -2'
const SPARKLE_RADIUS = 10

/**
 * One Dialogue event per sparkle, on ASS **Layer 1** so they draw above the
 * glyphs (Layer 0) in the same burn. Each twinkles in and back out via
 * `\fad(half,half)` and pulses `\fscx/\fscy` up at mid-life and back down —
 * the same shape `sparkleStateAt` gives the preview, so the two match.
 */
function sparkleEvents(o: AssOverlay): string[] {
  if (!o.sparkles?.length) return []
  const color = assColor(o.sparkleColor ?? '#ffffff')
  return o.sparkles.map((s) => {
    const lifeMs = Math.max(1, Math.round((s.endSec - s.startSec) * 1000))
    const halfMs = Math.round(lifeMs / 2)
    // \fscx is a percentage of the drawing's natural size, so a radius-10 star
    // needs sizePx/10 * 100 percent to reach `sizePx`.
    const full = Math.max(1, Math.round((s.sizePx / SPARKLE_RADIUS) * 100))
    const small = Math.max(1, Math.round(full * 0.4))
    const tags = [
      '\\an5',
      `\\pos(${Math.round(s.x)},${Math.round(s.y)})`,
      `\\1c${color}&`,
      '\\bord0',
      '\\shad0',
      `\\frz${Math.round(s.rotDeg)}`,
      `\\fad(${halfMs},${lifeMs - halfMs})`,
      `\\fscx${small}\\fscy${small}`,
      `\\t(0,${halfMs},\\fscx${full}\\fscy${full})`,
      `\\t(${halfMs},${lifeMs},\\fscx${small}\\fscy${small})`,
      '\\p1'
    ]
    return `Dialogue: 1,${assTime(s.startSec)},${assTime(s.endSec)},Sparkle,,0,0,0,,{${tags.join('')}}${SPARKLE_PATH}{\\p0}`
  })
}

/** Text events (when there is text) plus its sparkles (when there are any). */
function overlayEvents(o: AssOverlay, pxScale: number): string[] {
  const text = o.text.trim().length > 0 ? textEvents(o, pxScale) : []
  return [...text, ...sparkleEvents(o)]
}

/**
 * The Dialogue event(s) for one overlay. A static overlay is a single \pos
 * event. Animations map onto tags within one event where possible (\fad for
 * fades, \t for the bounce scale pop, \k for word-by-word); a slide uses \move,
 * and since an event carries at most ONE \move, combinations that need two
 * (slide in + slide out) split into entrance / static / exit events at the
 * same computed position (no visual pop at the boundary — verified).
 * Typewriter emits one event per reveal step: the not-yet-revealed characters
 * ride along with their fill/outline/shadow alphas forced transparent
 * (\1a\3a\4a &HFF&), which keeps the centered layout stable; with a pill only
 * \1a\4a are hidden so the full-size box shows from the start (both verified —
 * docs/FFMPEG-NOTES.md).
 */
function textEvents(o: AssOverlay, pxScale: number): string[] {
  const style = o.pill.enabled ? 'Pill' : 'Plain'
  const an = o.anchor === 'center' ? 5 : 7
  const x = Math.round(o.x)
  const y = Math.round(o.y)
  const base: string[] = [`\\an${an}`, fontTags(o.fontFamily), `\\fs${Math.round(o.fontSizePx)}`, `\\c${assColor(o.color)}&`]
  if (o.pill.enabled) {
    // BorderStyle=3 opaque box: \3c is the box colour, \bord its padding.
    base.push(`\\3c${assColor(o.pill.color)}&`, `\\bord${Math.round(o.pill.padPx)}`)
  }
  const deco = decoTags(o.pill.enabled, o.stroke, o.shadow)
  if (deco) base.push(deco)
  const pos = `\\pos(${x},${y})`

  const ev = (t0: number, t1: number, tags: string[], text: string): string =>
    `Dialogue: 0,${assTime(t0)},${assTime(t1)},${style},,0,0,0,,{${tags.join('')}}${text}`

  const anim = o.animation && (o.animation.in !== 'none' || o.animation.out !== 'none') ? o.animation : null
  if (!anim) return [ev(o.startSec, o.endSec, [base[0], pos, ...base.slice(1)], escapeText(o.text))]

  const dur = Math.max(0.01, o.endSec - o.startSec)
  const { inSec, outSec } = clampAnimWindows(anim, dur)
  const inMs = Math.round(inSec * 1000)
  const outMs = Math.round(outSec * 1000)
  // Slide travel is a logical-px constant; scale it like every other length.
  const slide = Math.round(SLIDE_DIST_PX * pxScale)
  const events: string[] = []

  // Exit needs its own event only for slideDown (a second \move); fades ride
  // whichever event touches the overlay end via \fad(…, outMs).
  const splitExit = anim.out === 'slideDown'
  const exitStart = splitExit ? o.endSec - outSec : o.endSec
  const fadeOutMs = anim.out === 'fadeOut' ? outMs : 0

  // Tags an event needs when it TOUCHES the overlay end (fade-out only).
  const tailFade = (from: string[]): string[] => (fadeOutMs > 0 ? [...from, `\\fad(0,${fadeOutMs})`] : from)

  switch (anim.in) {
    case 'slideUp': {
      const tags = [base[0], `\\move(${x},${y + slide},${x},${y},0,${inMs})`, ...base.slice(1)]
      if (splitExit) {
        events.push(ev(o.startSec, o.startSec + inSec, [...tags, `\\fad(${inMs},0)`], escapeText(o.text)))
        if (exitStart > o.startSec + inSec + 0.001) {
          events.push(ev(o.startSec + inSec, exitStart, [base[0], pos, ...base.slice(1)], escapeText(o.text)))
        }
      } else {
        events.push(ev(o.startSec, o.endSec, [...tags, `\\fad(${inMs},${fadeOutMs})`], escapeText(o.text)))
      }
      break
    }
    case 'typewriter': {
      const steps = typewriterSteps(o.text.length)
      const stepDur = steps.length > 0 ? inSec / steps.length : 0
      // Hide unrevealed glyphs, keeping layout: fill+shadow always, outline only
      // without a pill (with one, \3a would blank the box for those chars).
      const hide = o.pill.enabled ? '{\\1a&HFF&\\4a&HFF&}' : '{\\1a&HFF&\\3a&HFF&\\4a&HFF&}'
      const posTags = [base[0], pos, ...base.slice(1)]
      steps.forEach((chars, k) => {
        const t0 = o.startSec + k * stepDur
        const t1 = k === steps.length - 1 ? o.startSec + inSec : o.startSec + (k + 1) * stepDur
        const body =
          chars >= o.text.length
            ? escapeText(o.text)
            : `${escapeText(o.text.slice(0, chars))}${hide}${escapeText(o.text.slice(chars))}`
        events.push(ev(t0, Math.min(t1, exitStart), posTags, body))
      })
      if (exitStart > o.startSec + inSec + 0.001) {
        events.push(ev(o.startSec + inSec, exitStart, tailFade(posTags), escapeText(o.text)))
      }
      break
    }
    case 'wordHighlight': {
      // One karaoke event across the window: a word flips from the dimmed
      // secondary fill (\2c + \2a) to the primary at the START of its \k
      // interval (verified). Whitespace rides with the preceding word.
      const winEnd = exitStart
      const winDur = Math.max(0.01, winEnd - o.startSec)
      const words = splitWords(o.text)
      const perWordCs = words.map((_, i) => {
        const b0 = Math.round(((i * winDur) / words.length) * 100)
        const b1 = Math.round((((i + 1) * winDur) / words.length) * 100)
        return b1 - b0
      })
      let wi = 0
      let body = ''
      for (const tok of o.text.split(/(\s+)/)) {
        if (tok.length === 0) continue
        if (/^\s+$/.test(tok)) body += escapeText(tok)
        else body += `{\\k${perWordCs[Math.min(wi++, perWordCs.length - 1)]}}${escapeText(tok)}`
      }
      const tags = tailFade([base[0], pos, ...base.slice(1), `\\2c${assColor(o.color)}&`, `\\2a&H99&`])
      events.push(ev(o.startSec, winEnd, tags, body))
      break
    }
    case 'bounce': {
      const peakMs = Math.round(inMs * BOUNCE_OVERSHOOT_FRAC)
      const s0 = Math.round(BOUNCE_START_SCALE * 100)
      const s1 = Math.round(BOUNCE_OVERSHOOT_SCALE * 100)
      const fadeMs = Math.min(inMs, Math.round(BOUNCE_FADE_SEC * 1000))
      const tags = [
        base[0],
        pos,
        ...base.slice(1),
        `\\fscx${s0}\\fscy${s0}`,
        `\\t(0,${peakMs},\\fscx${s1}\\fscy${s1})`,
        `\\t(${peakMs},${inMs},\\fscx100\\fscy100)`,
        `\\fad(${fadeMs},${splitExit ? 0 : fadeOutMs})`
      ]
      events.push(ev(o.startSec, exitStart, tags, escapeText(o.text)))
      break
    }
    case 'fadeIn':
    case 'none': {
      const enterMs = anim.in === 'fadeIn' ? inMs : 0
      const tags = [base[0], pos, ...base.slice(1)]
      if (enterMs > 0 || (!splitExit && fadeOutMs > 0)) {
        tags.push(`\\fad(${enterMs},${splitExit ? 0 : fadeOutMs})`)
      }
      events.push(ev(o.startSec, exitStart, tags, escapeText(o.text)))
      break
    }
  }

  if (splitExit) {
    const tags = [
      base[0],
      `\\move(${x},${y},${x},${y + slide},0,${outMs})`,
      ...base.slice(1),
      `\\fad(0,${outMs})`
    ]
    events.push(ev(exitStart, o.endSec, tags, escapeText(o.text)))
  }
  return events
}
