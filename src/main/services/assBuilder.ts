/**
 * PURE generator for an ASS subtitle file that burns text blocks — text layers
 * AND captions, which are the same thing and go through the same code — into
 * the export. PlayResX/Y match the OUTPUT size (the exporter pre-scales all
 * geometry to output px), so what you positioned in the preview is what burns.
 *
 * libass paints; it does not lay out. Its line breaking and leading differ from
 * the preview's CSS (it spaces lines by the font's Windows metrics, 1.3–1.9x the
 * size), so each block arrives with its LINES already laid out by Chromium from
 * the preview's own CSS (`textLayout.ts`), and every line burns as its own event
 * exactly there, with `WrapStyle: 2` so libass never re-wraps it. The glyph
 * size, baseline and outline are corrected for libass (`shared/textStyle.ts`);
 * the pill is a vector drawing of the box Chromium measured (rounded, with its
 * alpha), not a libass BorderStyle-3 box. Layers: pills 0, glyphs 1, sparkles 2.
 * All verified against the bundled ffmpeg — docs/FFMPEG-NOTES.md "libass text
 * metrics". The font name (`\fn`) comes from the bundled-font catalog; the faces
 * reach libass via `fontsdir` (see exporterArgs). Gradient text does NOT come
 * through here — it's rendered to a PNG and composited (ASS has no gradients).
 */

import type { PillStyle, ShadowStyle, StrokeStyle } from '@shared/project'
import { pillRadiusPx } from '@shared/project'
import { resolveFont } from '@shared/fonts'
import {
  assBaselineBelowPos,
  assFontSize,
  assOutlineWidth,
  DEFAULT_TEXT_SHADOW,
  effectiveShadow,
  effectiveStroke,
  usesDefaultShadow
} from '@shared/textStyle'
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
import { fallbackLines, type LaidOutLine } from './textLayout'

/** A text block to burn — a text layer or a caption (geometry in output px). */
export interface AssOverlay {
  text: string
  startSec: number
  endSec: number
  /** Block centre: the rotation origin, and where a block without `lines`
   *  is centred. */
  x: number
  y: number
  /** Bundled-font id (shared/fonts) — resolved to a libass `\fn` name here. */
  fontFamily: string
  /** CSS font size (output px) — converted to libass `\fs` here. */
  fontSizePx: number
  color: string
  pill: PillStyle
  /** Outline (output px, CSS width). Ignored when `pill.enabled`. */
  stroke?: StrokeStyle | null
  /** Drop shadow (output px). */
  shadow?: ShadowStyle | null
  /** Output px per logical px of decoration (scales the default legibility
   *  shadow, a logical constant). Default 1. */
  decoScale?: number
  /** Clockwise rotation about (x, y), degrees (captions). */
  rotationDeg?: number
  /** Chromium's layout of the block (`textLayout.ts`). Absent = the
   *  newline-only fallback, centred on (x, y). */
  lines?: LaidOutLine[]
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

/** The colour part only (`&HBBGGRR`): libass colour tags ignore alpha. */
const assRgb = (hex: string): string => `&H${assColor(hex).slice(4)}`

/** The alpha override for colour slot `n` (1 fill, 3 outline, 4 shadow) — none
 *  when opaque. `\1c`/`\3c`/`\4c` drop a colour's alpha; `\Na` carries it
 *  (verified: a #000000cc pill burns 80% opaque, not solid). */
function alphaTag(n: 1 | 3 | 4, hex: string): string[] {
  const a = assColor(hex).slice(2, 4)
  return a === '00' ? [] : [`\\${n}a&H${a}&`]
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

const f1 = (n: number): string => (Math.round(n * 10) / 10).toString()
const r = (n: number): number => Math.round(n)

/** `\fn…\b…` — the resolved font face + its bold flag (all bundled faces b0). */
function fontTags(fontFamilyId: string): string {
  const def = resolveFont(fontFamilyId)
  return `\\fn${def.assName}\\b${def.assBold}`
}

/**
 * libass stand-in for the preview's default legibility shadow
 * (`DEFAULT_TEXT_SHADOW`: a soft drop plus a tight glow): a thin blurred dark
 * outline for the glow and a blurred straight-down shadow for the drop. CSS
 * text-shadow has no exact libass twin — this is matched by eye.
 */
function defaultShadowTags(k: number): string[] {
  const d = DEFAULT_TEXT_SHADOW
  return [
    `\\bord${f1(d.glowBlur * 0.5 * k)}`,
    '\\3c&H000000&',
    '\\3a&H1A&',
    '\\xshad0',
    `\\yshad${f1(d.dropY * k)}`,
    '\\4c&H000000&',
    '\\4a&H1A&',
    `\\blur${f1(d.glowBlur * k)}`
  ]
}

/**
 * Outline + shadow tags, identical for text layers and captions. The outline is
 * HALF the CSS width (`assOutlineWidth` — libass draws `\bord` wholly outside,
 * CSS shows half); a pill replaces it. The Plain style has neither, so absent
 * tags mean none.
 */
function decoTags(o: AssOverlay): string[] {
  if (usesDefaultShadow(o)) return defaultShadowTags(o.decoScale ?? 1)
  const tags: string[] = []
  const stroke = effectiveStroke(o)
  if (stroke) {
    tags.push(`\\bord${f1(assOutlineWidth(stroke.widthPx))}`, `\\3c${assRgb(stroke.color)}&`, ...alphaTag(3, stroke.color))
  }
  const shadow = effectiveShadow(o)
  if (shadow) {
    tags.push(`\\shad${f1(Math.max(0, shadow.distancePx))}`, `\\4c${assRgb(shadow.color)}&`, ...alphaTag(4, shadow.color))
    if (shadow.blur > 0) tags.push(`\\blur${f1(shadow.blur)}`)
  }
  return tags
}

/** A rounded rectangle `w`×`h` as a `\p1` path from (0,0) — the pill box
 *  Chromium measured, corners at `pillRadiusPx` (the preview's radius). */
export function pillPath(w: number, h: number, radius: number): string {
  const q = Math.max(0, Math.min(radius, w / 2, h / 2))
  const k = q * 0.5523 // cubic-bezier quarter circle
  const n = f1
  return [
    `m ${n(q)} 0`,
    `l ${n(w - q)} 0`,
    `b ${n(w - q + k)} 0 ${n(w)} ${n(q - k)} ${n(w)} ${n(q)}`,
    `l ${n(w)} ${n(h - q)}`,
    `b ${n(w)} ${n(h - q + k)} ${n(w - q + k)} ${n(h)} ${n(w - q)} ${n(h)}`,
    `l ${n(q)} ${n(h)}`,
    `b ${n(q - k)} ${n(h)} 0 ${n(h - q + k)} 0 ${n(h - q)}`,
    `l 0 ${n(q)}`,
    `b 0 ${n(q - k)} ${n(q - k)} 0 ${n(q)} 0`
  ].join(' ')
}

/**
 * `pxScale` is output px per logical px (`frameToOutput(...).s`) — the one
 * length this builder derives itself, the slide-animation travel, is a logical
 * constant. Every built-in format renders 1:1, hence the default.
 */
export function buildAss(overlays: AssOverlay[], target: Target, pxScale = 1): string {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // 2 = never wrap: every line arrives laid out (by Chromium), one event each.
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${target.width}`,
    `PlayResY: ${target.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Bold=0: bundled faces carry their own weight (no libass faux-bold). Every
    // event sets its own font, size and decoration inline, so the style holds
    // no outline or shadow of its own — text and captions share it.
    'Style: Plain,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    // Only for a pill with no measured box (the layout fallback): libass's own
    // BorderStyle-3 box — square, sized from the font's line box.
    'Style: Pill,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1',
    // Sparkles are \p1 vector drawings, not glyphs: no outline, no shadow, and
    // centre-anchored so \pos places the sparkle's middle.
    'Style: Sparkle,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

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
 * One Dialogue event per sparkle, on ASS **Layer 2** so they draw above the
 * glyphs (Layer 1) and pills (Layer 0) in the same burn. Each twinkles in and
 * back out via `\fad(half,half)` and pulses `\fscx/\fscy` up at mid-life and
 * back down — the same shape `sparkleStateAt` gives the preview, so the two
 * match.
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
    return `Dialogue: 2,${assTime(s.startSec)},${assTime(s.endSec)},Sparkle,,0,0,0,,{${tags.join('')}}${SPARKLE_PATH}{\\p0}`
  })
}

/** Text events (when there is text) plus its sparkles (when there are any). */
function overlayEvents(o: AssOverlay, pxScale: number): string[] {
  const text = o.text.trim().length > 0 ? blockEvents(o, pxScale) : []
  return [...text, ...sparkleEvents(o)]
}

/** Hides unrevealed typewriter glyphs while keeping their layout space (the
 *  pill is a separate drawing, so all three paints can go). */
const HIDE = '{\\1a&HFF&\\3a&HFF&\\4a&HFF&}'

/** One burned piece of a block: a line of glyphs, or a line's pill drawing. */
interface Piece {
  layer: 0 | 1
  style: 'Plain' | 'Pill'
  /** `\an5` position (the piece's centre). */
  x: number
  y: number
  /** Tags after position/rotation: font/colour/decoration, or the fill. */
  tags: string[]
  /** A glyph line: its run in the block text. */
  line?: LaidOutLine
  /** A pill drawing: its path. */
  path?: string
}

/**
 * The Dialogue events for one block: a pill drawing (Layer 0) and a glyph event
 * (Layer 1) per laid-out line, each at the line's own position — the baseline
 * Chromium measured, less libass's centre-to-baseline drop. Animations map onto
 * tags on every piece alike (\fad for fades, \t for the bounce scale pop, \k for
 * word-by-word, \move for slides); since an event carries at most ONE \move,
 * slide in + slide out split into entrance / static / exit events at the same
 * position (no visual pop at the boundary — verified). Typewriter reveals line
 * by line: each line gets an event per change in ITS revealed count, the
 * not-yet-revealed characters riding along transparent (\1a\3a\4a &HFF&) so
 * the centred layout never shifts; karaoke gives each line a leading empty \k
 * for the words before it (verified: an empty syllable is a delay). A bounce
 * scales each line about its own centre (the preview scales the whole block),
 * so multi-line text pops very slightly differently for those 0.45s.
 */
function blockEvents(o: AssOverlay, pxScale: number): string[] {
  const laid = o.lines ?? fallbackLines(o.text, o.x, o.y, o.fontFamily, o.fontSizePx)
  const drop = assBaselineBelowPos(o.fontFamily, o.fontSizePx)
  const glyphTags = [
    fontTags(o.fontFamily),
    `\\fs${f1(assFontSize(o.fontFamily, o.fontSizePx))}`,
    `\\c${assRgb(o.color)}&`,
    ...alphaTag(1, o.color),
    ...decoTags(o)
  ]
  const rot = o.rotationDeg ? [`\\org(${r(o.x)},${r(o.y)})`, `\\frz${f1(-o.rotationDeg)}`] : []

  const pieces: Piece[] = []
  if (o.pill.enabled) {
    const radius = pillRadiusPx(o.pill.padPx)
    const fill = ['\\bord0', '\\shad0', `\\1c${assRgb(o.pill.color)}&`, ...alphaTag(1, o.pill.color)]
    for (const l of laid) {
      if (!l.pill) continue
      const p = l.pill
      pieces.push({ layer: 0, style: 'Plain', x: p.x + p.w / 2, y: p.y + p.h / 2, tags: fill, path: pillPath(p.w, p.h, radius) })
    }
  }
  for (const l of laid) {
    // No measured box (layout fallback): libass draws its own square one.
    const libassBox = o.pill.enabled && !l.pill
    const tags = libassBox
      ? [...glyphTags, `\\3c${assRgb(o.pill.color)}&`, ...alphaTag(3, o.pill.color), `\\bord${f1(o.pill.padPx)}`]
      : glyphTags
    pieces.push({ layer: 1, style: libassBox ? 'Pill' : 'Plain', x: l.cx, y: l.baseline - drop, tags, line: l })
  }
  const glyphs = pieces.filter((p) => !p.path)
  const pills = pieces.filter((p) => p.path)

  const ev = (p: Piece, t0: number, t1: number, tags: string[], body: string): string =>
    `Dialogue: ${p.layer},${assTime(t0)},${assTime(t1)},${p.style},,0,0,0,,{${tags.join('')}}${body}`
  const at = (p: Piece, extra: string[] = []): string[] => ['\\an5', `\\pos(${r(p.x)},${r(p.y)})`, ...rot, ...p.tags, ...extra]
  const moving = (p: Piece, dy0: number, dy1: number, ms: number, extra: string[]): string[] => [
    '\\an5',
    `\\move(${r(p.x)},${r(p.y + dy0)},${r(p.x)},${r(p.y + dy1)},0,${ms})`,
    ...rot,
    ...p.tags,
    ...extra
  ]
  /** Characters of a glyph line visible once `chars` of the block are revealed. */
  const revealed = (p: Piece, chars: number): number =>
    Math.max(0, Math.min(p.line!.end - p.line!.start, chars - p.line!.start))
  const body = (p: Piece, reveal: number | null = null): string => {
    if (p.path) return `{\\p1}${p.path}{\\p0}`
    const run = o.text.slice(p.line!.start, p.line!.end)
    if (reveal == null) return escapeText(run)
    const n = revealed(p, reveal)
    return n >= run.length ? escapeText(run) : `${escapeText(run.slice(0, n))}${HIDE}${escapeText(run.slice(n))}`
  }

  const anim = o.animation && (o.animation.in !== 'none' || o.animation.out !== 'none') ? o.animation : null
  if (!anim) return pieces.map((p) => ev(p, o.startSec, o.endSec, at(p), body(p)))

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
      for (const p of pieces) {
        if (splitExit) {
          events.push(ev(p, o.startSec, o.startSec + inSec, moving(p, slide, 0, inMs, [`\\fad(${inMs},0)`]), body(p)))
          if (exitStart > o.startSec + inSec + 0.001) {
            events.push(ev(p, o.startSec + inSec, exitStart, at(p), body(p)))
          }
        } else {
          events.push(ev(p, o.startSec, o.endSec, moving(p, slide, 0, inMs, [`\\fad(${inMs},${fadeOutMs})`]), body(p)))
        }
      }
      break
    }
    case 'typewriter': {
      const steps = typewriterSteps(o.text.length)
      const stepDur = steps.length > 0 ? inSec / steps.length : 0
      // The pill is there from the start (the preview keeps its box too).
      for (const p of pills) events.push(ev(p, o.startSec, exitStart, tailFade(at(p)), body(p)))
      for (const p of glyphs) {
        // One event per distinct revealed count of THIS line; a line still
        // waiting its turn emits nothing.
        for (let k0 = 0; k0 < steps.length; ) {
          const shown = revealed(p, steps[k0])
          let k1 = k0
          while (k1 + 1 < steps.length && revealed(p, steps[k1 + 1]) === shown) k1++
          const t0 = o.startSec + k0 * stepDur
          const t1 = k1 === steps.length - 1 ? o.startSec + inSec : o.startSec + (k1 + 1) * stepDur
          if (shown > 0) events.push(ev(p, t0, Math.min(t1, exitStart), at(p), body(p, steps[k0])))
          k0 = k1 + 1
        }
        if (exitStart > o.startSec + inSec + 0.001) {
          events.push(ev(p, o.startSec + inSec, exitStart, tailFade(at(p)), body(p)))
        }
      }
      break
    }
    case 'wordHighlight': {
      // A karaoke event per line across the window: a word flips from the
      // dimmed secondary fill (\2c + \2a) to the primary at the START of its \k
      // interval (verified). Whitespace rides with the preceding word; a line
      // opens with an empty \k covering every word before it.
      const winEnd = exitStart
      const winDur = Math.max(0.01, winEnd - o.startSec)
      const words = splitWords(o.text)
      const perWordCs = words.map((_, i) => {
        const b0 = Math.round(((i * winDur) / words.length) * 100)
        const b1 = Math.round((((i + 1) * winDur) / words.length) * 100)
        return b1 - b0
      })
      const toks: { s: number; t: string; w: number }[] = []
      let pos = 0
      let wi = 0
      for (const t of o.text.split(/(\s+)/)) {
        if (t.length > 0) toks.push({ s: pos, t, w: /^\s+$/.test(t) ? -1 : wi++ })
        pos += t.length
      }
      for (const p of pills) events.push(ev(p, o.startSec, winEnd, tailFade(at(p)), body(p)))
      for (const p of glyphs) {
        const mine = toks.filter((tk) => tk.s >= p.line!.start && tk.s < p.line!.end)
        const firstWord = mine.find((tk) => tk.w >= 0)?.w ?? 0
        const delay = perWordCs.slice(0, firstWord).reduce((a, b) => a + b, 0)
        let kara = delay > 0 ? `{\\k${delay}}` : ''
        for (const tk of mine) {
          kara += tk.w < 0 ? escapeText(tk.t) : `{\\k${perWordCs[Math.min(tk.w, perWordCs.length - 1)]}}${escapeText(tk.t)}`
        }
        const tags = tailFade(at(p, [`\\2c${assRgb(o.color)}&`, '\\2a&H99&']))
        events.push(ev(p, o.startSec, winEnd, tags, kara))
      }
      break
    }
    case 'bounce': {
      const peakMs = Math.round(inMs * BOUNCE_OVERSHOOT_FRAC)
      const s0 = Math.round(BOUNCE_START_SCALE * 100)
      const s1 = Math.round(BOUNCE_OVERSHOOT_SCALE * 100)
      const fadeMs = Math.min(inMs, Math.round(BOUNCE_FADE_SEC * 1000))
      const pop = [
        `\\fscx${s0}\\fscy${s0}`,
        `\\t(0,${peakMs},\\fscx${s1}\\fscy${s1})`,
        `\\t(${peakMs},${inMs},\\fscx100\\fscy100)`,
        `\\fad(${fadeMs},${splitExit ? 0 : fadeOutMs})`
      ]
      for (const p of pieces) events.push(ev(p, o.startSec, exitStart, at(p, pop), body(p)))
      break
    }
    case 'fadeIn':
    case 'none': {
      const enterMs = anim.in === 'fadeIn' ? inMs : 0
      const fade = enterMs > 0 || (!splitExit && fadeOutMs > 0) ? [`\\fad(${enterMs},${splitExit ? 0 : fadeOutMs})`] : []
      for (const p of pieces) events.push(ev(p, o.startSec, exitStart, at(p, fade), body(p)))
      break
    }
  }

  if (splitExit) {
    for (const p of pieces) {
      events.push(ev(p, exitStart, o.endSec, moving(p, 0, slide, outMs, [`\\fad(0,${outMs})`]), body(p)))
    }
  }
  return events
}
