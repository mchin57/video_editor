/**
 * A GRAPHICS layer's export: every mark becomes its own overlay. The
 * mark is drawn by the export's Chromium from the SAME SVG the preview shows
 * (`shared/graphics.ts` → `markSvg`), cropped to the mark's bounds, then
 * composited where the layer transform puts that box — following the layer's
 * position/scale/opacity keyframes like any image layer. Each mark is gated to
 * `[layer start + max(0, atSec), layer end)` — a mark whose moment fell before
 * the tile's start (a trim) shows from the start, mid-reveal; a fade adds an
 * alpha fade-in from the mark's own moment, a draw-on
 * becomes a short PNG sequence sampled from the preview's own reveal timing.
 *
 * A mark with its own keyframes (`shared/markAnim.ts`) that actually change is
 * ANIMATED: it is rendered frame by frame like the pose overlay
 * (`renderOverlayVideo`, one `markArtSvg` per output frame — the preview's own
 * drawing, reveal included) and composited as an alpha video where the still
 * would sit. Any other mark stays a still (or fade/draw-on sequence) drawn at its
 * constant pose, so a static rotation/size/opacity or a single keyframe shows too.
 */

import type { GraphicsContent, Layer } from '@shared/project'
import {
  drawOnFrameCount,
  REVEAL_SEC,
  drawOnProgress,
  LABEL_FONT_FAMILY,
  revealLead,
  markBounds,
  markShapes,
  markSvg,
  markTitle,
  placedBox,
  svgWrap,
  type GraphicMark
} from '@shared/graphics'
import {
  isMarkAnimated,
  isPosed,
  markArtSvg,
  markPoseAt,
  markPoseSvg,
  posedBounds,
  posedMark,
  type MarkPose
} from '@shared/markAnim'
import type { ExportImage, ExportKeyframe, ExportVideo } from './exporterArgs'
import type { CompositionRender } from './exportRender'

type Box = { x: number; y: number; w: number; h: number }

/** The export's frame rate (`exporterArgs`: `-r 30`). */
const FPS = 30

export async function exportGraphicsLayer(pass: CompositionRender, l: Layer, c: GraphicsContent): Promise<void> {
  for (const mark of c.marks) {
    if (isMarkAnimated(mark)) {
      const video = await exportAnimatedMark(pass, l, mark)
      if (video) pass.visuals.push({ kind: 'video', video })
      continue
    }
    const image = await exportMark(pass, l, mark)
    if (image) pass.visuals.push({ kind: 'image', image })
  }
}

/** Where the layer transform (and its keyframes) put a mark-space `box`, in output px. */
function placement(
  pass: CompositionRender,
  l: Layer,
  box: Box
): { boxW: number; boxH: number; x: number; y: number; keyframes: ExportKeyframe[] } {
  const { m, s } = pass
  const at = placedBox(box, l)
  const boxW = at.w * s
  const boxH = at.h * s
  const keyframes = (l.keyframes ?? []).map((kf): ExportKeyframe => {
    const p = placedBox(box, kf)
    return { t: l.startSec + kf.tSec, w: p.w * s, h: p.h * s, cx: m.x(p.cx), cy: m.y(p.cy) }
  })
  return { boxW, boxH, x: m.x(at.cx) - boxW / 2, y: m.y(at.cy) - boxH / 2, keyframes }
}

/** Raster size for a mark-space box: the largest the layer ever shows it (its base or
 *  keyframed zoom) so a zoom-in stays sharp — capped to fit the window. */
function rasterSize(pass: CompositionRender, l: Layer, box: Box): { pxW: number; pxH: number } {
  const { s, target } = pass
  const maxScale = Math.max(l.scale, ...(l.keyframes ?? []).map((k) => k.scale))
  const k = Math.min(s * maxScale, target.width / box.w, target.height / box.h)
  return { pxW: Math.max(1, Math.floor(box.w * k)), pxH: Math.max(1, Math.floor(box.h * k)) }
}

/** An animated mark: one frame per output frame from its moment to the layer's end, as an alpha video. */
async function exportAnimatedMark(pass: CompositionRender, l: Layer, mark: GraphicMark): Promise<ExportVideo | null> {
  const first = Math.max(0, mark.atSec)
  const startSec = l.startSec + first
  if (startSec >= l.endSec || markShapes(mark, 1).length === 0) return null
  const count = Math.max(1, Math.ceil((l.endSec - startSec) * FPS - 1e-9))
  const localAt = (i: number): number => first + i / FPS
  // One fixed frame holding the mark at every pose it takes, so nothing is cropped.
  let box = posedBounds(mark, markPoseAt(mark, localAt(0)))
  for (let i = 1; i < count; i++) {
    const b = posedBounds(mark, markPoseAt(mark, localAt(i)))
    const x = Math.min(box.x, b.x)
    const y = Math.min(box.y, b.y)
    box = { x, y, w: Math.max(box.x + box.w, b.x + b.w) - x, h: Math.max(box.y + box.h, b.y + b.h) - y }
  }
  const { pxW, pxH } = rasterSize(pass, l, box)
  // A stills render (render_frame) only shows a few frames: draw just those
  // (±1 for the output's frame rounding); the rest are one blank picture.
  const wanted = pass.o.frames
    ? new Set(
        pass.o.frames.flatMap((f) => {
          const i = Math.floor((f.timeSec - startSec) * FPS)
          return [i - 1, i, i + 1]
        })
      )
    : null
  const svgAt = (i: number): string =>
    svgWrap(wanted && !wanted.has(i) ? '' : markArtSvg(mark, localAt(i), LABEL_FONT_FAMILY), box, pxW, pxH)
  const path = await pass.renderOverlayVideo(count, svgAt, pxW, pxH).catch((error: unknown) => {
    throw new Error(`Couldn't draw a graphics mark (${markTitle(mark)}) for the export: ${(error as Error).message}`)
  })
  return {
    path,
    inSec: 0,
    len: count / FPS,
    hdrChain: '',
    hasAlpha: true,
    inputDecoder: null,
    crop: null,
    flipH: false,
    flipV: false,
    colorEq: '',
    freezes: [],
    speed: 1,
    ...placement(pass, l, box),
    startSec,
    endSec: l.endSec,
    opacity: await pass.opacityAnim(l)
  }
}

/** A posed mark's standalone SVG at reveal `progress` (a fade is the overlay's alpha `fade`, not baked in). */
function posedSvg(mark: GraphicMark, pose: MarkPose, progress: number, box: Box, pxW: number, pxH: number): string {
  return svgWrap(markPoseSvg(mark, pose, progress, 1, LABEL_FONT_FAMILY), box, pxW, pxH)
}

async function exportMark(pass: CompositionRender, l: Layer, mark: GraphicMark): Promise<ExportImage | null> {
  const startSec = l.startSec + Math.max(0, mark.atSec)
  if (startSec >= l.endSec || markShapes(mark, 1).length === 0) return null
  // Not animated: one constant pose (its static values, or its lone keyframe).
  // A plain pose takes the unposed path, byte-for-byte as before.
  const pose = markPoseAt(mark, 0)
  const posed = isPosed(pose) || pose.opacity !== 1 || pose.drawn !== 1
  const drawn = posedMark(mark, pose)
  const box = posed ? posedBounds(mark, pose) : markBounds(drawn)
  const { pxW, pxH } = rasterSize(pass, l, box)
  // A mark whose moment fell before the tile's start (a trim or split — negative
  // `atSec`) shows from the start with whatever is left of its reveal.
  const lead = revealLead(mark)
  const frames = mark.reveal === 'draw' ? drawOnFrameCount(mark) : 1
  const draw = frames > 1
  const fade = mark.reveal === 'fade' && lead < REVEAL_SEC
  const svgs = Array.from({ length: frames }, (_, i) => {
    const progress = draw ? drawOnProgress(mark, i) : 1
    return posed
      ? posedSvg(mark, pose, progress, box, pxW, pxH)
      : markSvg(drawn, progress, box, pxW, pxH, LABEL_FONT_FAMILY)
  })
  // No fallback (unlike text, which can burn flat): a coaching mark that
  // silently vanished would be worse than a failed export that says why.
  const { paths, pattern } = await pass.renderSvgImages(svgs, pxW, pxH).catch((error: unknown) => {
    throw new Error(`Couldn't draw a graphics mark (${markTitle(mark)}) for the export: ${(error as Error).message}`)
  })

  return {
    path: draw ? pattern : paths[0],
    ...placement(pass, l, box),
    startSec,
    endSec: l.endSec,
    opacity: 1,
    opacityAnim: await pass.opacityAnim(l),
    ...(draw ? { sequence: { frames } } : {}),
    // The fade runs from the mark's own moment, which may be before it shows.
    ...(fade ? { fadeIn: { startSec: l.startSec + mark.atSec, durSec: REVEAL_SEC } } : {})
  }
}
