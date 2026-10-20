/**
 * Burned text in an export — text layers and captions, which are ONE thing: both
 * become a `textBlockSpec` (the preview's layout inputs in output px). Blocks
 * libass can't draw (a gradient, colour emoji, a fixed wrap width) rasterise to
 * a full-frame PNG with the preview's CSS; everything else is queued on the
 * pass, laid out by Chromium in one go and burned by libass one event per line
 * (docs/SHARED.md "Burned text", FFMPEG-NOTES "libass text metrics").
 */

import type { Layer, TextContent, TextStyleBase } from '@shared/project'
import { effectiveCaptionStyle } from '@shared/project'
import { clampAnimWindows, effectiveTextAnimation } from '@shared/textAnim'
import { activeSparkle, sparklesFor } from '@shared/sparkle'
import { normalizeDeg, rotateVec } from '@shared/rotation'
import { textMotion, type LinearMotion } from '@shared/motion'
import { hasColorEmoji, textWrapWidth } from '@shared/textStyle'
import type { ExportImage, Target } from './exporterArgs'
import type { AssOverlay, AssSparkle } from './assBuilder'
import type { TextImageSpec } from './textImage'
import { decorationScale, scaledPill, scaledShadow, scaledStroke } from './textScale'
import { r } from './ffmpegFilters'
import type { CompositionRender, OutputMap } from './exportRender'
import { createLogger } from '@shared/log'

const log = createLogger('export')

/**
 * One text block — a text layer or a caption, the same thing — as the export
 * sees it: the preview's layout inputs mapped to output px. `k` is the layer's
 * own scale (1 for a caption): the preview lays the block out unscaled and
 * scales it whole, so the font, fixed width, auto-wrap width and decorations
 * all grow by `k` together.
 */
export function textBlockSpec(
  text: string,
  st: TextStyleBase,
  at: { x: number; y: number },
  k: number,
  m: OutputMap,
  frameW: number,
  extra: { widthPx?: number; rotationDeg?: number } = {}
): TextImageSpec {
  const deco = decorationScale(k, m.s)
  return {
    text,
    xCenter: m.x(at.x),
    yCenter: m.y(at.y),
    fontFamily: st.fontFamily,
    fontSizePx: st.fontSizePx * k * m.s,
    color: st.color,
    gradient: st.gradient ?? undefined,
    pill: scaledPill(st.pill, deco),
    stroke: scaledStroke(st.stroke, deco) ?? null,
    shadow: scaledShadow(st.shadow, deco) ?? null,
    widthPx: extra.widthPx != null ? extra.widthPx * k * m.s : undefined,
    wrapWidthPx: textWrapWidth(frameW) * k * m.s,
    decoScale: deco,
    rotationDeg: extra.rotationDeg
  }
}

/** The libass burn of a block spec over [startSec, endSec) (lines added once
 *  Chromium has laid it out). A gradient that couldn't rasterise burns flat in
 *  its first colour. */
export function blockOverlay(spec: TextImageSpec, startSec: number, endSec: number): AssOverlay {
  return {
    text: spec.text,
    startSec,
    endSec,
    x: spec.xCenter,
    y: spec.yCenter,
    fontFamily: spec.fontFamily,
    fontSizePx: spec.fontSizePx,
    color: spec.gradient ? spec.gradient.from : spec.color,
    pill: spec.pill,
    stroke: spec.stroke,
    shadow: spec.shadow,
    decoScale: spec.decoScale,
    rotationDeg: spec.rotationDeg
  }
}

/** A pre-rendered, output-sized PNG composited 1:1 over the frame (rasterised text). */
export function fullFrameImage(path: string, startSec: number, endSec: number, t: Target): ExportImage {
  return { path, boxW: t.width, boxH: t.height, x: 0, y: 0, startSec, endSec, opacity: 1 }
}

export async function exportTextLayer(pass: CompositionRender, l: Layer, c: TextContent): Promise<void> {
  if (c.text.trim().length === 0) return
  const { m, frame, target } = pass
  // The preview scales the WHOLE overlay (`transform: scale(layer.scale)`),
  // so a resized text layer grows its font, wrap width, pill padding,
  // stroke and shadow together — `textBlockSpec` applies `l.scale` to all
  // of them (scaling decorations by the output scale alone once left a
  // 1.43x-resized overlay wearing a pill sized for the unscaled text).
  const rotationDeg = l.rotationDeg ? normalizeDeg(l.rotationDeg) : 0
  // Straight-line motion (text follows its keyframes for POSITION only —
  // `textMotion`, which the preview resolves through too). The block is laid
  // out where the move STARTS; the burn carries the travel as an offset.
  const mo = textMotion(l.keyframes)
  const at = mo ? { x: mo.x0, y: mo.y0 } : { x: l.x, y: l.y }
  const travel: LinearMotion | null =
    mo && (mo.x1 !== mo.x0 || mo.y1 !== mo.y0)
      ? {
          t0: l.startSec + mo.t0,
          t1: l.startSec + mo.t1,
          x0: 0,
          y0: 0,
          x1: (mo.x1 - mo.x0) * m.s,
          y1: (mo.y1 - mo.y0) * m.s
        }
      : null
  const spec = textBlockSpec(c.text, c, at, l.scale, m, frame.w, { widthPx: c.widthPx, rotationDeg })
  // Sparkles are computed from the SAME shared helper the preview uses, at
  // the output-scaled font size — every offset it returns is a multiple of
  // that size, so the layout matches the preview at any preset. Positions
  // become absolute output px here; the ASS builder only formats them.
  const sparkleEffect = activeSparkle(c.effects)
  const textAnim = effectiveTextAnimation(c)
  const layerDur = Math.max(0.01, l.endSec - l.startSec)
  const sparkles: AssSparkle[] = sparkleEffect
    ? sparklesFor({
        effect: sparkleEffect,
        text: c.text,
        fontSizePx: spec.fontSizePx,
        durSec: layerDur,
        typewriterSec: textAnim?.in === 'typewriter' ? clampAnimWindows(textAnim, layerDur).inSec : 0
      }).map((sp) => {
        // Sparkle offsets are in the text block's own axes; a rotated block
        // carries them round its centre (the preview draws them inside the
        // rotated box, so they turn with it for free).
        const off = rotateVec(sp.x, sp.y, rotationDeg)
        return {
          startSec: l.startSec + sp.tSec,
          endSec: Math.min(l.endSec, l.startSec + sp.tSec + sp.lifeSec),
          x: r(m.x(at.x) + off.x),
          y: r(m.y(at.y) + off.y),
          sizePx: sp.sizePx,
          rotDeg: sp.rotDeg + rotationDeg
        }
      })
    : []
  // A gradient (libass can't do it), an explicit wrap width OR colour emoji
  // (libass draws them as monochrome outlines, #7) burns as a full-frame
  // PNG overlay, rasterised with the same CSS the preview uses.
  if (c.gradient || c.widthPx != null || hasColorEmoji(c.text)) {
    try {
      // A moving block is rasterised at the frame CENTRE (so a move that
      // starts off-frame isn't clipped out of the PNG) and the full-frame
      // image travels via the image keyframe path, centre-anchored.
      const image = travel
        ? {
            ...(await pass.renderTextImage(
              { ...spec, xCenter: target.width / 2, yCenter: target.height / 2 },
              l.startSec,
              l.endSec
            )),
            keyframes: [
              { t: travel.t0, w: target.width, h: target.height, cx: spec.xCenter, cy: spec.yCenter },
              {
                t: travel.t1,
                w: target.width,
                h: target.height,
                cx: spec.xCenter + travel.x1,
                cy: spec.yCenter + travel.y1
              }
            ]
          }
        : await pass.renderTextImage(spec, l.startSec, l.endSec)
      pass.visuals.push({ kind: 'image', image })
      // The glyphs are an image now, but the sparkles are still vector ASS
      // events — burn them on their own, above the picture, so a gradient
      // or wrapped overlay is not silently stripped of its effect. (Empty
      // text: `buildAss` emits the sparkles only.)
      if (sparkles.length > 0) {
        const sparkleAss = pass.nextTextFile()
        await pass.writeAss(sparkleAss, [
          {
            ...blockOverlay(spec, l.startSec, l.endSec),
            text: '',
            sparkles,
            sparkleColor: sparkleEffect!.color,
            motion: travel
          }
        ])
        pass.visuals.push({ kind: 'text', assFile: sparkleAss })
      }
      return
    } catch (error) {
      log.warn(`rasterising text failed; burning it flat: ${JSON.stringify(c.text.slice(0, 40))}`, error)
      // Rasterising failed — fall through to a flat-colour ASS burn so the
      // overlay still appears (losing the gradient or the emoji colour; the
      // layout keeps the wrap width).
    }
  }
  // Burned through libass: reserve its slot in the stack now, write it
  // once the whole comp has been laid out.
  const file = pass.nextTextFile()
  pass.visuals.push({ kind: 'text', assFile: file })
  pass.burn(
    spec,
    {
      ...blockOverlay(spec, l.startSec, l.endSec),
      // Resolved (not raw): rasterised text (gradient/wrap fallback) never
      // animates, and the preview resolves through the same helper.
      animation: textAnim,
      sparkles,
      sparkleColor: sparkleEffect?.color,
      motion: travel
    },
    file
  )
}

/**
 * Captions burn on top of everything, through the SAME block path as a text
 * layer (a caption is a text block at scale 1 that may be rotated): each
 * segment at its effective style (per-segment override, else the lane's). A
 * gradient caption, or one with colour emoji (#7), rasterises to a PNG
 * composited over the caption track; a failed render falls back to a flat burn.
 */
export async function addCaptions(pass: CompositionRender): Promise<void> {
  const { comp, m, frame } = pass
  if (!comp.captions.enabled) return
  for (const seg of comp.captions.segments) {
    if (!seg.enabled || seg.text.trim().length === 0) continue
    const st = effectiveCaptionStyle(comp.captions, seg)
    const spec = textBlockSpec(seg.text, st, st, 1, m, frame.w, { rotationDeg: st.rotationDeg })
    if (st.gradient || hasColorEmoji(seg.text)) {
      try {
        pass.captionOverlays.push(await pass.renderTextImage(spec, seg.startSec, seg.endSec))
        continue
      } catch (error) {
        log.warn(`rasterising a caption failed; burning it flat: ${JSON.stringify(seg.text.slice(0, 40))}`, error)
        // un-rendered → burns flat below
      }
    }
    pass.captionsAss = 'captions.ass'
    pass.burn(spec, blockOverlay(spec, seg.startSec, seg.endSec), pass.captionsAss)
  }
}
