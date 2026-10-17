/**
 * Scaling a text overlay's DECORATIONS from the logical document into output px.
 *
 * The preview scales a text layer by transforming the whole overlay
 * (`transform: scale(layer.scale)` on the wrapper div, sizes in logical px), so
 * the glyphs, the pill padding, the stroke and the shadow all grow together and
 * their proportions are fixed by the document. The export instead computes every
 * value in absolute output px, which means each one has to be multiplied by the
 * SAME factor — and the pill/stroke/shadow were being multiplied by the output
 * scale only, leaving `layer.scale` out. A 1.43x-resized overlay therefore burned
 * with a pill sized for the unscaled text.
 *
 * `decorationScale` is that one factor, and the tests pin the invariant that
 * actually matters: decoration-to-font ratios survive the trip unchanged.
 */

import type { PillStyle, ShadowStyle, StrokeStyle } from '@shared/project'

/**
 * Logical px → output px for everything attached to a text layer.
 * `layerScale` is the layer's own resize; `outputScale` maps the 1080x1920
 * logical frame onto the export target. The font size uses this same product,
 * which is exactly why the decorations must too.
 */
export function decorationScale(layerScale: number, outputScale: number): number {
  return layerScale * outputScale
}

/** Stroke width in output px. */
export const scaledStroke = (s: StrokeStyle | null | undefined, k: number): StrokeStyle | null | undefined =>
  s ? { widthPx: s.widthPx * k, color: s.color } : s

/** Shadow offset + blur in output px. */
export const scaledShadow = (s: ShadowStyle | null | undefined, k: number): ShadowStyle | null | undefined =>
  s ? { distancePx: s.distancePx * k, color: s.color, blur: s.blur * k } : s

/** Pill padding in output px (the radius is derived from it downstream). */
export const scaledPill = (p: PillStyle, k: number): PillStyle => ({ ...p, padPx: p.padPx * k })
