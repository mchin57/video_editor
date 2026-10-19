/**
 * What a drag on the preview canvas does to the document — pure, so the rules
 * are unit-tested (`canvasDrag.test.ts`) and not only reachable through a
 * pointer. `PreviewStage` measures the pointer and the box; these turn that
 * into the edited layer / caption lane, and `liveUpdate` applies the result
 * every pointermove (each call works from the drag-start snapshot, so it is
 * idempotent).
 *
 * The three ways a drag can change a layer's position (`DragMode`):
 * - `path`     — a simple two-keyframe move, or a text layer with keyframes
 *                (text only ever follows its motion): the whole path shifts;
 * - `keyframe` — any other keyframed layer: write a keyframe at the playhead
 *                (keyframes override the base transform);
 * - `base`     — the base transform.
 */

import type { CaptionsConfig, CaptionStyle, Layer, LayerKeyframe } from '@shared/project'
import { layerTransformAt, upsertKeyframe, type ResizeBox, type ResizeHandle } from '@shared/layers'
import { isSimpleMotion, shiftKeyframes } from '@shared/motion'
import { kindInfo } from '@shared/layerKinds'
import { clamp } from '@shared/math'

export type DragMode = 'path' | 'keyframe' | 'base'

/** A layer that moves as a PATH on the canvas: a simple two-keyframe move, or
 *  a text layer with any keyframes (text only ever follows its motion). Drags
 *  and resizes shift the whole path instead of writing a keyframe. */
export const onPath = (l: Layer): boolean =>
  !!l.keyframes?.length && (isSimpleMotion(l.keyframes) || kindInfo(l).keyframes === 'path')

/** `l` with its whole path — base position and every keyframe — moved by
 *  (dx, dy) from the drag-start snapshot `raw`. */
export const movePath = (l: Layer, raw: Layer, dx: number, dy: number): Layer => ({
  ...l,
  x: raw.x + dx,
  y: raw.y + dy,
  keyframes: raw.keyframes ? shiftKeyframes(raw.keyframes, dx, dy) : raw.keyframes
})

/** How a drag edits `layer`: its stored form `raw` decides path-ness; the
 *  effective `layer` (at the playhead) whether keyframes override it. */
export function dragMode(raw: Layer, layer: Layer): DragMode {
  if (onPath(raw)) return 'path'
  return layer.keyframes?.length && kindInfo(layer).keyframes !== 'path' ? 'keyframe' : 'base'
}

/** The keyframe a drag writes at timeline time `t`: its offset in the layer,
 *  the scale in effect there, and the opacity in effect there (a drag writes
 *  position / size — it must not reset a fade; full opacity is stored as
 *  absence). */
export interface DragKeyframe {
  tSec: number
  scale: number
  extra: Pick<LayerKeyframe, 'opacity'>
}

export function dragKeyframe(layer: Layer, t: number): DragKeyframe {
  const tr = layerTransformAt(layer, t)
  return {
    tSec: clamp(t - layer.startSec, 0, Math.max(0, layer.endSec - layer.startSec)),
    scale: tr.scale,
    extra: tr.opacity < 1 ? { opacity: tr.opacity } : {}
  }
}

/** Layer `l` moved so its centre is at (nx, ny), for a drag that started on
 *  `layer` (effective at the playhead) / `raw` (stored). */
export function movedLayer(
  l: Layer,
  layer: Layer,
  raw: Layer,
  mode: DragMode,
  nx: number,
  ny: number,
  kf: DragKeyframe
): Layer {
  if (mode === 'path') return movePath(l, raw, nx - layer.x, ny - layer.y)
  if (mode === 'keyframe') {
    return {
      ...l,
      keyframes: upsertKeyframe(layer.keyframes, { tSec: kf.tSec, x: nx, y: ny, scale: kf.scale, ...kf.extra })
    }
  }
  return { ...l, x: nx, y: ny }
}

/**
 * Layer `l` resized by one handle: `startBox` is the measured box at drag
 * start and `nb` the new one (`resizeRotatedBox`), with the new centre
 * (x, y). Corners scale uniformly (aspect kept); edges stretch media per axis
 * or, for text, change the wrap width. A path layer shifts (and, from a
 * corner, scales its keyframes); a keyframed one writes a keyframe at the
 * playhead from a corner.
 */
export function resizedLayer(
  l0: Layer,
  layer: Layer,
  raw: Layer,
  mode: DragMode,
  handle: ResizeHandle,
  startBox: Pick<ResizeBox, 'w' | 'h'>,
  nb: Pick<ResizeBox, 'w' | 'h'>,
  x: number,
  y: number,
  kf: Pick<DragKeyframe, 'tSec' | 'extra'>
): Layer {
  const isCorner = handle.length === 2
  const isText = layer.content.kind === 'text'
  const path = mode === 'path'
  let l = l0
  if (path) {
    const f = isCorner ? nb.w / startBox.w : 1
    const moved = movePath(l0, raw, x - layer.x, y - layer.y)
    l =
      f === 1
        ? moved
        : { ...moved, keyframes: moved.keyframes?.map((k) => ({ ...k, scale: clamp(k.scale * f, 0.05, 8) })) }
  }
  if (isCorner) {
    const ns = clamp(layer.scale * (nb.w / startBox.w), 0.05, 8)
    if (mode === 'keyframe') {
      return { ...l, keyframes: upsertKeyframe(layer.keyframes, { tSec: kf.tSec, x, y, scale: ns, ...kf.extra }) }
    }
    return { ...l, ...(path ? {} : { x, y }), scale: path && !isText ? raw.scale : ns }
  }
  const xy = path ? {} : { x, y }
  if (isText && l.content.kind === 'text') {
    // widthPx is the pre-scale wrap width; the measured box is post-scale.
    return { ...l, ...xy, content: { ...l.content, widthPx: nb.w / layer.scale } }
  }
  if (handle === 'e' || handle === 'w') {
    return { ...l, ...xy, stretchX: (layer.stretchX ?? 1) * (nb.w / startBox.w) }
  }
  return { ...l, ...xy, stretchY: (layer.stretchY ?? 1) * (nb.h / startBox.h) }
}

/** One end of a simple move (a `MotionPath` dot) moved by (dx, dy): the other
 *  end and both times stay put. `kfs` must be a simple motion. */
export function movedMotionEnd(kfs: LayerKeyframe[], end: 0 | 1, dx: number, dy: number): LayerKeyframe[] {
  const sorted = [...kfs].sort((a, b) => a.tSec - b.tSec)
  const k0 = sorted[end]
  const moved = { ...k0, x: k0.x + dx, y: k0.y + dy }
  return end === 0 ? [moved, sorted[1]] : [sorted[0], moved]
}

/**
 * A caption drag's style change. Lane-wide mode (`global`, the "Captions"
 * label selected) edits the lane style — every caption without its own
 * override follows; otherwise segment `segId` gets (or updates) its own
 * override, seeded from the lane style, which exempts it from the lane.
 */
export function withCaptionStyle(
  captions: CaptionsConfig,
  segId: string,
  global: boolean,
  patch: Partial<CaptionStyle>
): CaptionsConfig {
  if (global) return { ...captions, style: { ...captions.style, ...patch } }
  return {
    ...captions,
    segments: captions.segments.map((s) =>
      s.id === segId ? { ...s, style: { ...(s.style ?? captions.style), ...patch } } : s
    )
  }
}
