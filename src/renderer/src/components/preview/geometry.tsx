/** Preview ▸ layer geometry: a layer's box and fill in canonical CSS, its keyframed transform at a time, and measuring the selected box for the handles. */

import { type CSSProperties } from 'react'
import type { Layer, VideoContent } from '@shared/project'
import { type MediaAsset } from '@shared/media'
import { layerTransformAt, stretchedBox, type ResizeBox } from '@shared/layers'
import { kindInfo } from '@shared/layerKinds'
import { isSimpleMotion, shiftKeyframes } from '@shared/motion'
import { normalizeDeg } from '@shared/rotation'
import { LOGICAL } from '@/lib/coords'
import { pct } from './frame'

/** The layer with its keyframed transform baked in for rendering at time `t`,
 *  for kinds whose keyframes drive the transform (`LAYER_KINDS`): text follows
 *  its keyframes as a position path instead, and layouts / compound clips
 *  ignore them — the export has no keyframe path for those. */
export function withKeyframedTransform(l: Layer, t: number): Layer {
  if (!l.keyframes?.length || kindInfo(l).keyframes !== 'transform') return l
  const tr = layerTransformAt(l, t)
  return { ...l, x: tr.x, y: tr.y, scale: tr.scale }
}
/** Absolute box (in %) for a media layer, sized to its aspect at the layer's
 *  scale and centered on (x,y). Aspect-correct so there's no letterbox fill to
 *  occlude the layers behind it; anything past the frame is cropped by the stage. */
export function mediaBox(layer: Layer, aspect: number): CSSProperties {
  const { w, h } = stretchedBox(aspect, layer.scale, layer.stretchX ?? 1, layer.stretchY ?? 1, LOGICAL)
  const rot = layerRotation(layer)
  return {
    position: 'absolute',
    left: pct(layer.x - w / 2, LOGICAL.width),
    top: pct(layer.y - h / 2, LOGICAL.height),
    width: pct(w, LOGICAL.width),
    height: pct(h, LOGICAL.height),
    // About the box centre (the default origin) — the export's `rotate` turns
    // the same sized box about the same point.
    ...(rot ? { transform: `rotate(${rot}deg)` } : {})
  }
}
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
/** A layer's rotation, normalised (0 = upright). @see shared/rotation.ts */
export const layerRotation = (layer: Pick<Layer, 'rotationDeg'>): number =>
  layer.rotationDeg ? normalizeDeg(layer.rotationDeg) : 0
/** Mirror transform for flipped media, or undefined. */
export const flipTransform = (c: { flipH?: boolean; flipV?: boolean }): string | undefined =>
  c.flipH || c.flipV ? `scaleX(${c.flipH ? -1 : 1}) scaleY(${c.flipV ? -1 : 1})` : undefined
/** CSS for the <video>/<img> filling its layer box (crop/color aware). */
export function videoFillStyle(content: VideoContent, asset: MediaAsset | undefined): CSSProperties {
  const crop = content.crop
  const v = asset?.probe.video
  const col = content.color
  const filter = col
    ? `brightness(${1 + col.brightness}) contrast(${col.contrast}) saturate(${col.saturation})`
    : undefined
  if (crop && v) {
    return {
      position: 'absolute',
      width: `${(v.displayWidth / crop.w) * 100}%`,
      height: `${(v.displayHeight / crop.h) * 100}%`,
      left: `${-(crop.x / crop.w) * 100}%`,
      top: `${-(crop.y / crop.h) * 100}%`,
      objectFit: 'fill',
      maxWidth: 'none',
      filter
    }
  }
  return { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', filter }
}
export const mediaAspect = (asset: MediaAsset | undefined, content: VideoContent | { crop?: undefined }): number => {
  if ('crop' in content && content.crop) return content.crop.w / content.crop.h
  const v = asset?.probe.video
  return v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 1
}
/** The selected element's box as the handles need it: centre + UNROTATED size
 *  in logical px, its rotation, and the stage's screen px per logical px (for
 *  handle gaps that stay a constant on-screen size). */
export interface MeasuredBox extends ResizeBox {
  rotationDeg: number
  pxPerLogical: number
}
/** Measure the selected element's box (tagged `data-resizebox`) via the stage.
 *  Text height is intrinsic so it must be read from the DOM; measuring media the
 *  same way keeps one path and tracks any live transform. The bounding rect of a
 *  ROTATED box is its screen-aligned hull, so only its centre is used (rotation
 *  is about the centre); size and angle come from the layout box and the
 *  element's own transform. */
export function measureSelectedBox(stage: HTMLElement): MeasuredBox | null {
  const el = stage.querySelector('[data-resizebox]') as HTMLElement | null
  if (!el) return null
  const er = el.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  if (sr.width === 0 || stage.offsetWidth === 0) return null
  const s = LOGICAL.width / sr.width
  // Stage-local CSS px → screen px (the canvas may itself be scaled).
  const local = sr.width / stage.offsetWidth
  const t = getComputedStyle(el).transform
  const m = t && t !== 'none' ? new DOMMatrixReadOnly(t) : new DOMMatrixReadOnly()
  const own = Math.hypot(m.a, m.b) || 1
  return {
    cx: (er.left + er.width / 2 - sr.left) * s,
    cy: (er.top + er.height / 2 - sr.top) * s,
    w: el.offsetWidth * own * local * s,
    h: el.offsetHeight * own * local * s,
    rotationDeg: normalizeDeg((Math.atan2(m.b, m.a) * 180) / Math.PI),
    pxPerLogical: 1 / s
  }
}
