/**
 * A video clip's POSE OVERLAY in the export: the skeleton changes every frame,
 * so it is rendered as an animation — one frame per output frame of the clip's
 * window, each the shared `clipPoseShapes` at that frame's SOURCE time (the
 * preview's own mapping, so freezes, speed and trims line up), drawn by the
 * export's Chromium in the clip's view space — encoded to a lossless alpha
 * intermediate and composited right above the clip with the clip's exact box,
 * position, rotation, keyframes and opacity. The overlay therefore moves,
 * zooms and fades with the footage it was detected on.
 */

import type { Layer, VideoContent } from '@shared/project'
import { LABEL_FONT_FAMILY, shapesSvg } from '@shared/graphics'
import { videoSourceTime } from '@shared/layers'
import { clipPoseShapes, clipPoseView } from '@shared/pose'
import type { ExportVideo } from './exporterArgs'
import type { CompositionRender } from './exportRender'
import { getPose } from './poseDetect'

/** The export's frame rate (`exporterArgs`: `-r 30`). */
const FPS = 30

/** Push the clip's pose overlay (if it shows one) right above `clip`, its
 *  just-pushed compositor entry. `display` is the source's upright size. */
export async function exportPoseOverlay(
  pass: CompositionRender,
  l: Layer,
  c: VideoContent,
  clip: ExportVideo,
  display: { w: number; h: number }
): Promise<void> {
  const settings = c.pose
  if (!settings?.show || settings.people.length === 0) return
  const data = await getPose(c.mediaId, pass.ctx.session)
  if (!data) return
  const view = clipPoseView(c, data, display)
  const count = Math.max(1, Math.ceil((l.endSec - l.startSec) * FPS - 1e-9))
  // Drawn at the largest size the clip box reaches (base or keyframed zoom),
  // capped to the capture window, so a zoom-in stays sharp.
  const maxScale = Math.max(l.scale, ...(l.keyframes ?? []).map((k) => k.scale))
  const grow = Math.min(maxScale / (l.scale || 1), pass.target.width / clip.boxW, pass.target.height / clip.boxH)
  const pxW = Math.max(2, Math.floor(clip.boxW * grow))
  const pxH = Math.max(2, Math.floor(clip.boxH * grow))
  const frame = { x: 0, y: 0, w: view.size.w, h: view.size.h }
  // A stills render (render_frame) only shows a few frames: draw just those
  // (±1 for the output's frame rounding); every other frame is the same empty
  // picture, which the rasteriser reuses instead of capturing again.
  const wanted = pass.o.frames
    ? new Set(
        pass.o.frames.flatMap((f) => {
          const i = Math.floor((f.timeSec - l.startSec) * FPS)
          return [i - 1, i, i + 1]
        })
      )
    : null
  const svgAt = (i: number): string =>
    shapesSvg(
      wanted && !wanted.has(i) ? [] : clipPoseShapes(data, settings, videoSourceTime(c, l, l.startSec + i / FPS), view),
      frame,
      pxW,
      pxH,
      LABEL_FONT_FAMILY
    )
  const path = await pass.renderOverlayVideo(count, svgAt, pxW, pxH).catch((error: unknown) => {
    throw new Error(`Couldn't draw the pose overlay for the export: ${(error as Error).message}`)
  })
  pass.visuals.push({
    kind: 'video',
    video: {
      ...clip,
      // Its own frames, already in timeline order: no trim, crop, flip,
      // grade, freeze or speed of the clip applies to them again.
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
      ramp: undefined,
      opacity: await pass.opacityAnim(l)
    }
  })
}
