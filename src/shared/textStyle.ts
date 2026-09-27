/**
 * A text layer and a caption are the SAME thing: a `TextStyleBase` in a
 * centred, auto-wrapping block. This module is the one definition of how that
 * block looks, shared by every surface that draws one:
 *
 *  - the PREVIEW builds React style objects from it (lengths in `cqw`),
 *  - the export RASTERISER (`textImage.ts`) builds inline CSS from it (lengths
 *    in output px) — so a gradient text/caption burns exactly as previewed,
 *  - the ASS BURN (`assBuilder.ts`) takes its numbers from the same constants,
 *    corrected for how libass differs from CSS (`assFontSize` & co.).
 *
 * Before this, text layers and captions carried separate copies of all of it in
 * both the preview and the export, and the copies had drifted: different wrap
 * widths, a caption box capped at half the frame, a raster box capped at the
 * space right of its centre, and a raster path without the default shadow.
 */

import type { PillStyle, TextStyleBase } from './project'
import { pillRadiusPx } from './project'
import { fontCssFamily, resolveFont } from './fonts'

/** A CSS declaration block as a React-style object (camelCase keys). */
export type Css = Record<string, string | number>
/** Formats a length (logical or output px) as a CSS length: `cqw` in the
 *  preview, `px` in the rasteriser. */
export type CssLength = (px: number) => string

/** Leading, as a multiple of the font size. (Was Tailwind `leading-tight`.) */
export const TEXT_LINE_HEIGHT = 1.25

/** Auto-wrap width as a fraction of the FRAME width, for text and captions. */
export const TEXT_WRAP_FRAC = 0.92

export function textWrapWidth(frameWidth: number): number {
  return frameWidth * TEXT_WRAP_FRAC
}

/**
 * The block box: font, leading and wrap. Positioning (a translate on the
 * caller's side) is not included — the box must be positioned by TRANSFORM,
 * never by `left`, because an absolutely positioned box can only shrink-wrap
 * into the space right of its `left` edge (a box centred at `left: 50%` wraps
 * at half the frame). `width: max-content` + `max-width` reads the same as the
 * old shrink-to-fit everywhere and cannot be capped by the page it sits in.
 */
export function textBoxCss(
  s: Pick<TextStyleBase, 'fontFamily' | 'fontSizePx'>,
  wrap: { widthPx?: number; wrapWidthPx: number },
  len: CssLength
): Css {
  return {
    fontFamily: fontCssFamily(s.fontFamily),
    fontWeight: 'normal',
    fontSize: len(s.fontSizePx),
    lineHeight: TEXT_LINE_HEIGHT,
    whiteSpace: 'pre-wrap',
    textAlign: 'center',
    ...(wrap.widthPx != null
      ? { width: len(wrap.widthPx) }
      : { width: 'max-content', maxWidth: len(wrap.wrapWidthPx) })
  }
}

/** The decoration subset of a text style. */
export type TextDeco = Pick<TextStyleBase, 'color' | 'pill' | 'stroke' | 'shadow' | 'gradient'>

/** The outline actually drawn: a pill replaces it (the Inspector says "off
 *  while pill on"). */
export function effectiveStroke(s: TextDeco): TextStyleBase['stroke'] {
  return !s.pill.enabled && s.stroke && s.stroke.widthPx > 0 ? s.stroke : null
}

/** The drop shadow actually drawn (a zero-size shadow is none). */
export function effectiveShadow(s: TextDeco): TextStyleBase['shadow'] {
  return s.shadow && (s.shadow.distancePx > 0 || s.shadow.blur > 0) ? s.shadow : null
}

/**
 * The legibility shadow text gets when nothing else separates it from the
 * picture (no pill, outline or shadow): a soft drop plus a tight glow. Logical
 * px — it does not scale with the font, only with the layer.
 */
export const DEFAULT_TEXT_SHADOW = { dropY: 2.7, dropBlur: 6.48, glowBlur: 3.24, color: 'rgba(0,0,0,0.9)' } as const

/** Gradient text gets none: see `textFillCss`. */
export function usesDefaultShadow(s: TextDeco): boolean {
  return !s.pill.enabled && !effectiveStroke(s) && !effectiveShadow(s) && !s.gradient
}

/**
 * Glyph paint: flat colour or gradient (background-clip:text), outline
 * OUTSIDE the glyph (`paint-order: stroke fill` hides the inner half), shadow,
 * or the default legibility shadow. With a pill the glyphs are
 * `position: relative` so every line's text paints above every line's
 * background — otherwise a lower line's padding covers the line above. `k`
 * scales the default shadow (the export pre-scales everything else).
 *
 * Gradient text paints its fill as a text-clipped BACKGROUND under a
 * transparent glyph, so a `text-shadow` lands ON TOP of the gradient and smears
 * it dark (measured — it did in the preview). Its shadow is a `drop-shadow`
 * filter instead, which paints behind the rendered glyphs, and it takes no
 * default shadow.
 */
export function textFillCss(s: TextDeco, len: CssLength, k = 1): Css {
  const css: Css = {}
  if (s.gradient) {
    css.backgroundImage = `linear-gradient(${s.gradient.angle}deg, ${s.gradient.from}, ${s.gradient.to})`
    css.WebkitBackgroundClip = 'text'
    css.backgroundClip = 'text'
    css.color = 'transparent'
    css.WebkitTextFillColor = 'transparent'
  } else {
    css.color = s.color
  }
  const stroke = effectiveStroke(s)
  if (stroke) {
    css.WebkitTextStroke = `${len(stroke.widthPx)} ${stroke.color}`
    css.paintOrder = 'stroke fill'
  }
  const shadow = effectiveShadow(s)
  if (shadow) {
    const sh = `${len(shadow.distancePx)} ${len(shadow.distancePx)} ${len(shadow.blur)} ${shadow.color}`
    if (s.gradient) css.filter = `drop-shadow(${sh})`
    else css.textShadow = sh
  } else if (usesDefaultShadow(s)) {
    const d = DEFAULT_TEXT_SHADOW
    css.textShadow = `0 ${len(d.dropY * k)} ${len(d.dropBlur * k)} ${d.color}, 0 0 ${len(d.glowBlur * k)} ${d.color}`
  }
  if (s.pill.enabled) css.position = 'relative'
  return css
}

/** The per-line pill: an inline wrapper whose padded, rounded background
 *  `box-decoration-break: clone` repeats on EACH wrapped line. */
export function textPillCss(pill: PillStyle, len: CssLength): Css {
  return {
    background: pill.color,
    padding: len(pill.padPx),
    borderRadius: len(pillRadiusPx(pill.padPx)),
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone'
  }
}

/** A `Css` object as an inline declaration string (camelCase → kebab-case,
 *  `WebkitFoo` → `-webkit-foo`). */
export function cssText(css: Css): string {
  return Object.entries(css)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(';')
}

// --- libass corrections (verified — docs/FFMPEG-NOTES.md "libass text metrics")

/**
 * libass `\fs` for a CSS font size. CSS sizes the EM; libass scales the face so
 * its Windows ascent + descent equals `\fs`. Burning `\fs` = the CSS size drew
 * every font too small, by 1.30–1.94x depending on the face (0.64x for the
 * default Montserrat).
 */
export function assFontSize(fontId: string, cssPx: number): number {
  const { ascent, descent, unitsPerEm } = resolveFont(fontId).win
  return (cssPx * (ascent + descent)) / unitsPerEm
}

/**
 * How far below an `\an5` line's `\pos` libass puts the baseline: the line box
 * (Windows ascent + descent) is centred on `\pos`, the baseline sits Windows
 * ascent below its top. The exporter places each line so this lands on the
 * baseline Chromium measured.
 */
export function assBaselineBelowPos(fontId: string, cssPx: number): number {
  const { ascent, descent, unitsPerEm } = resolveFont(fontId).win
  return (cssPx * (ascent - descent)) / (2 * unitsPerEm)
}

/** libass `\bord` for a CSS outline: CSS strokes centre on the glyph edge and
 *  `paint-order: stroke fill` hides the inner half; libass draws `\bord`
 *  wholly outside. */
export function assOutlineWidth(cssStrokePx: number): number {
  return cssStrokePx / 2
}
