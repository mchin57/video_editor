/**
 * A WORKOUT OVERLAY's export: its widgets change every frame, so it renders as
 * an animation like the pose overlay — one frame per output frame of the
 * tile's window, each the shared `workoutOverlayShapes` at that frame's
 * timeline time (the preview's own mapping: ride window, speed, smoothing),
 * drawn by the export's Chromium over the box the widgets occupy (clipped to
 * the visible frame), encoded to a lossless alpha intermediate and composited
 * there.
 */

import type { Layer, WorkoutContent } from '@shared/project'
import { LABEL_FONT_FAMILY, shapesSvg } from '@shared/graphics'
import { workoutOverlayBounds, workoutOverlayShapes } from '@shared/workoutOverlay'
import type { CompositionRender } from './exportRender'
import { workoutSeries } from './mediaStore'

/** The export's frame rate (`exporterArgs`: `-r 30`). */
const FPS = 30

export async function exportWorkoutLayer(pass: CompositionRender, l: Layer, c: WorkoutContent): Promise<void> {
  const widgets = workoutOverlayBounds(c)
  if (!widgets) return
  const { frame, m, s } = pass
  // Only what can be seen: the widgets' box inside the output frame.
  const x0 = Math.max(widgets.x, frame.x)
  const y0 = Math.max(widgets.y, frame.y)
  const x1 = Math.min(widgets.x + widgets.w, frame.x + frame.w)
  const y1 = Math.min(widgets.y + widgets.h, frame.y + frame.h)
  if (x1 - x0 < 1 || y1 - y0 < 1) return
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  const series = await workoutSeries(c.mediaId, pass.ctx.session).catch((error: unknown) => {
    throw new Error(`Couldn't read the workout for its overlay: ${(error as Error).message}`)
  })
  const pxW = Math.max(2, Math.round(box.w * s))
  const pxH = Math.max(2, Math.round(box.h * s))
  const count = Math.max(1, Math.ceil((l.endSec - l.startSec) * FPS - 1e-9))
  // A stills render (render_frame) shows only a few frames: draw just those
  // (±1 for the output's frame rounding); the rest are left empty, which the
  // rasteriser reuses instead of capturing again.
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
      wanted && !wanted.has(i) ? [] : workoutOverlayShapes(c, l, series, l.startSec + i / FPS),
      box,
      pxW,
      pxH,
      LABEL_FONT_FAMILY
    )
  const path = await pass.renderOverlayVideo(count, svgAt, pxW, pxH).catch((error: unknown) => {
    throw new Error(`Couldn't draw the workout overlay for the export: ${(error as Error).message}`)
  })
  pass.visuals.push({
    kind: 'video',
    video: {
      path,
      inSec: 0,
      len: count / FPS,
      hdrChain: '',
      hasAlpha: true,
      inputDecoder: null,
      crop: null,
      colorEq: '',
      boxW: pxW,
      boxH: pxH,
      x: m.x(box.x),
      y: m.y(box.y),
      startSec: l.startSec,
      endSec: l.endSec,
      freezes: [],
      speed: 1
    }
  })
}
