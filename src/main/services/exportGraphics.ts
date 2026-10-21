/**
 * A GRAPHICS layer's export: every mark becomes its own image overlay. The
 * mark is drawn by the export's Chromium from the SAME SVG the preview shows
 * (`shared/graphics.ts` → `markSvg`), cropped to the mark's bounds, then
 * composited where the layer transform puts that box — following the layer's
 * position/scale/opacity keyframes like any image layer. Each mark is gated to
 * `[layer start + atSec, layer end)`; a fade adds an alpha fade-in, a draw-on
 * becomes a short PNG sequence sampled from the preview's own reveal timing.
 */

import type { GraphicsContent, Layer } from '@shared/project'
import {
  DRAW_ON_FRAMES,
  REVEAL_SEC,
  drawOnProgress,
  markBounds,
  markShapes,
  markSvg,
  markTitle,
  placedBox,
  type GraphicMark
} from '@shared/graphics'
import { DEFAULT_FONT_ID, fontCssFamily } from '@shared/fonts'
import type { ExportImage, ExportKeyframe } from './exporterArgs'
import type { CompositionRender } from './exportRender'

/** The angle label's face — what the preview's SVG names too. */
const LABEL_FONT = fontCssFamily(DEFAULT_FONT_ID)

export async function exportGraphicsLayer(pass: CompositionRender, l: Layer, c: GraphicsContent): Promise<void> {
  for (const mark of c.marks) {
    const image = await exportMark(pass, l, mark)
    if (image) pass.visuals.push({ kind: 'image', image })
  }
}

async function exportMark(pass: CompositionRender, l: Layer, mark: GraphicMark): Promise<ExportImage | null> {
  const { m, s, target } = pass
  const startSec = l.startSec + Math.max(0, mark.atSec)
  if (startSec >= l.endSec || markShapes(mark, 1).length === 0) return null
  const box = markBounds(mark)
  // Rasterise at the largest size the layer ever shows the mark (its base or
  // keyframed zoom) so a zoom-in stays sharp — capped to fit the window.
  const maxScale = Math.max(l.scale, ...(l.keyframes ?? []).map((k) => k.scale))
  const k = Math.min(s * maxScale, target.width / box.w, target.height / box.h)
  const pxW = Math.max(1, Math.floor(box.w * k))
  const pxH = Math.max(1, Math.floor(box.h * k))
  const draw = mark.reveal === 'draw'
  const frames = draw ? DRAW_ON_FRAMES : 1
  const svgs = Array.from({ length: frames }, (_, i) =>
    markSvg(mark, draw ? drawOnProgress(mark, i) : 1, box, pxW, pxH, LABEL_FONT)
  )
  // No fallback (unlike text, which can burn flat): a coaching mark that
  // silently vanished would be worse than a failed export that says why.
  const { paths, pattern } = await pass.renderSvgImages(svgs, pxW, pxH).catch((error: unknown) => {
    throw new Error(`Couldn't draw a graphics mark (${markTitle(mark)}) for the export: ${(error as Error).message}`)
  })

  const at = placedBox(box, l)
  const boxW = at.w * s
  const boxH = at.h * s
  const keyframes = (l.keyframes ?? []).map((kf): ExportKeyframe => {
    const p = placedBox(box, kf)
    return { t: l.startSec + kf.tSec, w: p.w * s, h: p.h * s, cx: m.x(p.cx), cy: m.y(p.cy) }
  })
  return {
    path: draw ? pattern : paths[0],
    boxW,
    boxH,
    x: m.x(at.cx) - boxW / 2,
    y: m.y(at.cy) - boxH / 2,
    startSec,
    endSec: l.endSec,
    opacity: 1,
    keyframes,
    opacityAnim: await pass.opacityAnim(l),
    ...(draw ? { sequence: { frames } } : {}),
    ...(mark.reveal === 'fade' ? { fadeInSec: REVEAL_SEC } : {})
  }
}
