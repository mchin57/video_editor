/**
 * Pure, dependency-free helpers for the unified layer stack. Shared by the
 * preview (renderer) and the exporter (main) so placement/timing/stacking math
 * is computed identically on both sides. Coordinates are canonical logical
 * 1080x1920 px; the project's output frame is a window on them (`frame.ts`).
 */

import type { Layer, LayerContent, LayerKeyframe, PillStyle, VideoContent } from './project'
import { playedBetween, sourceAfterPlayed } from './speed'
import { DEFAULT_FONT_ID } from './fonts'
import { FRAME, FULL_FRAME, type FrameRect } from './frame'

// The canonical space + output-frame window live in the leaf `frame.ts` (see its
// header for the init-order reason); re-exported so `layers.ts` stays the one
// geometry import for callers.
export { centeredFrame, FRAME, frameToOutput, FULL_FRAME, type FrameRect } from './frame'
export const HOOK_WINDOW_SEC = 3

// --- Frame fit (shared by preview + export) ----------------------------------

/**
 * Layer `scale` at which media of `aspect` exactly fits ("contains") `frame`.
 * `containBox` sizes media against the CANONICAL frame, so in any other format
 * scale 1 is not "fits the frame" — this is the conversion (always 1 in 9:16).
 * New media layers start at it, and the Inspector reads zoom relative to it.
 */
export function fitScale(aspect: number, frame: FrameRect = FULL_FRAME): number {
  return containBox(aspect, 1, { width: frame.w, height: frame.h }).w / containBox(aspect, 1).w
}

/**
 * The scale at which a layer exactly fits `frame` — what the Inspector shows as
 * 100% zoom. Video fits by its crop (else its source) aspect, an image by its
 * cropped + rotated aspect; text, layouts and compound clips are sized
 * frame-relative already (font px / `layoutCellRect`), so theirs is 1. An
 * unknown source aspect (media not probed yet) also reads as 1.
 */
export function layerFitScale(layer: Pick<Layer, 'content'>, sourceAspect: number | undefined, frame: FrameRect): number {
  const c = layer.content
  if (c.kind === 'video') {
    const aspect = c.crop ? c.crop.w / c.crop.h : sourceAspect
    return aspect && aspect > 0 ? fitScale(aspect, frame) : 1
  }
  if (c.kind === 'image' && sourceAspect && sourceAspect > 0) {
    return fitScale(effectiveImageAspect(sourceAspect, c.crop, c.rotateQuarters), frame)
  }
  return 1
}

/**
 * A media layer rescaled so its size RELATIVE TO THE FRAME survives an aspect
 * change of its source (a crop set or cleared): the base scale and every
 * keyframe scale move by `fitScale(to) / fitScale(from)`. In the 9:16 frame the
 * factor is 1 and the layer comes back unchanged — so "Crop to 16:9" in a 16:9
 * project fills it exactly as "Crop to 9:16" always filled a Reel.
 */
export function rescaleForAspect<L extends Pick<Layer, 'scale' | 'keyframes'>>(
  layer: L,
  fromAspect: number,
  toAspect: number,
  frame: FrameRect
): L {
  const k = fitScale(toAspect, frame) / fitScale(fromAspect, frame)
  if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-9) return layer
  return {
    ...layer,
    scale: layer.scale * k,
    ...(layer.keyframes ? { keyframes: layer.keyframes.map((kf) => ({ ...kf, scale: kf.scale * k })) } : {})
  }
}

// --- Geometry (shared by preview + export) ----------------------------------

/**
 * Aspect-fit ("contain") box for a media layer inside the frame, at the layer's
 * zoom: a wide-of-frame source fills the width, a tall one fills the height, then
 * both dims scale by `scale`. Returned in the same units as `frame` — logical px
 * for preview, output px when called with the output target. The identical math
 * lived in `exporter.layerBox` and `PreviewStage.mediaBox`. @see docs/SHARED.md
 */
export function containBox(
  aspect: number,
  scale: number,
  frame: { width: number; height: number } = FRAME
): { w: number; h: number } {
  const fa = frame.width / frame.height
  let w: number
  let h: number
  if (aspect >= fa) {
    w = frame.width
    h = frame.width / aspect
  } else {
    h = frame.height
    w = frame.height * aspect
  }
  return { w: w * scale, h: h * scale }
}

/**
 * Media box after the uniform `scale` AND the non-uniform edge-resize stretch:
 * `containBox` gives the aspect-fit size, then the stretch multipliers squash /
 * stretch each axis independently (media edge-resize distortion). Same math on
 * preview (`mediaBox`) and export (`exporter`). @see docs/SHARED.md
 */
export function stretchedBox(
  aspect: number,
  scale: number,
  stretchX = 1,
  stretchY = 1,
  frame: { width: number; height: number } = FRAME
): { w: number; h: number } {
  const { w, h } = containBox(aspect, scale, frame)
  return { w: w * stretchX, h: h * stretchY }
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
/** A layer's on-screen bounding box: center + size, all in logical px. */
export interface ResizeBox {
  cx: number
  cy: number
  w: number
  h: number
}

/**
 * New box after dragging `handle` by (dx, dy) logical px, keeping the OPPOSITE
 * edge/corner fixed. `aspect` (corner handles) scales both dims uniformly by the
 * pointer's projection onto the box diagonal; otherwise each grabbed edge moves
 * on its own (distortion). Pure + unit-tested; drives every stage resize.
 * @see docs/SHARED.md
 */
export function resizeBox(
  box: ResizeBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  aspect: boolean,
  minSize = 8
): ResizeBox {
  const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  if (aspect) {
    // Uniform scale anchored at the opposite corner: project the drag onto the
    // grabbed corner's diagonal (dirX, dirY) to get the scale factor.
    const dirX = hx * box.w
    const dirY = hy * box.h
    const denom = dirX * dirX + dirY * dirY || 1
    const f = Math.max(1 + (dx * dirX + dy * dirY) / denom, minSize / box.w, minSize / box.h)
    const w = box.w * f
    const h = box.h * f
    return {
      cx: box.cx - (hx * box.w) / 2 + (hx * w) / 2,
      cy: box.cy - (hy * box.h) / 2 + (hy * h) / 2,
      w,
      h
    }
  }
  let { cx, cy, w, h } = box
  if (hx !== 0) {
    const anchorX = box.cx - (hx * box.w) / 2
    w = Math.max(minSize, box.w + hx * dx)
    cx = anchorX + (hx * w) / 2
  }
  if (hy !== 0) {
    const anchorY = box.cy - (hy * box.h) / 2
    h = Math.max(minSize, box.h + hy * dy)
    cy = anchorY + (hy * h) / 2
  }
  return { cx, cy, w, h }
}

/**
 * Effective on-screen aspect of an image layer: the base source aspect, reshaped
 * by an optional 0..1 crop, then swapped for 90°/270° rotation. Used identically
 * by preview and export so a rotated/cropped image fills its box the same way.
 */
export function effectiveImageAspect(
  baseAspect: number,
  crop: { w: number; h: number } | null | undefined,
  rotateQuarters: number | undefined
): number {
  let aspect = baseAspect
  if (crop && crop.h > 0) aspect *= crop.w / crop.h
  const q = (((rotateQuarters ?? 0) % 4) + 4) % 4
  return q === 1 || q === 3 ? 1 / aspect : aspect
}

/** Layers on screen at timeline time `t`, in stack order (back → front). */
export function layersAtTime(layers: Layer[], t: number): Layer[] {
  return layers.filter((l) => t >= l.startSec && t < l.endSec)
}

/** Overall end of the visual stack (seconds). */
export function visualDuration(layers: Layer[]): number {
  return layers.reduce((max, l) => Math.max(max, l.endSec), 0)
}

/** Total extra played time a video layer's freeze holds add (seconds). Holds
 *  are wall-clock — speed does not scale them. */
export function freezeExtraSec(content: VideoContent): number {
  return (content.freezes ?? []).reduce((sum, f) => sum + Math.max(0, f.holdSec), 0)
}

/** Played (timeline) duration of a video layer's content: the source span at
 *  the clip's speed profile (constant or ramped), plus the wall-clock freeze
 *  holds. The `endSec` a store action should maintain is
 *  `startSec + playedVideoDuration(content)`. */
export function playedVideoDuration(content: VideoContent): number {
  return (
    Math.max(0, playedBetween(content, content.inSec, Math.max(content.inSec, content.outSec))) +
    freezeExtraSec(content)
  )
}

/**
 * Source-media time a video layer should show at timeline time `t`, honoring
 * freeze holds AND the clip's speed profile (constant `speed` or a keyframed
 * `speedRamp`). Played time runs `inSec → outSec` along the profile, pausing
 * on each freeze's source frame for its wall-clock `holdSec` — so the played
 * window is `playedBetween(in, out) + freezeExtraSec` long.
 */
export function videoSourceTime(content: VideoContent, layer: Layer, t: number): number {
  let local = t - layer.startSec // played time within the (stretched) layer
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  for (const f of freezes) {
    // Earlier holds are already removed from `local`, so this freeze sits at its
    // profile-mapped played distance from the in-point in the reduced timeline.
    const atPlayed = playedBetween(content, content.inSec, f.atSec)
    if (local < atPlayed) break // freeze is still ahead — normal profile mapping
    if (local < atPlayed + f.holdSec) return clampSrc(content, f.atSec) // inside the hold
    local -= Math.max(0, f.holdSec) // passed it: drop its hold as dead played time
  }
  return clampSrc(content, sourceAfterPlayed(content, content.inSec, Math.max(0, local)))
}

function clampSrc(content: VideoContent, s: number): number {
  return Math.min(content.outSec, Math.max(content.inSec, s))
}

/** True if timeline time `t` falls inside one of the layer's freeze holds. */
export function isFrozenAt(content: VideoContent, layer: Layer, t: number): boolean {
  let local = t - layer.startSec
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  for (const f of freezes) {
    const atPlayed = playedBetween(content, content.inSec, f.atSec)
    if (local < atPlayed) return false
    if (local < atPlayed + f.holdSec) return true
    local -= Math.max(0, f.holdSec)
  }
  return false
}

/**
 * Timeline time at which the layer shows SOURCE second `s` — the inverse of
 * `videoSourceTime` (for a source point inside a freeze hold, the hold's
 * start). Drives "seek to this keyframe" UI.
 */
export function videoTimelineTime(content: VideoContent, layer: Layer, s: number): number {
  const clamped = clampSrc(content, s)
  const holdsBefore = (content.freezes ?? []).reduce(
    (sum, f) => sum + (f.atSec < clamped ? Math.max(0, f.holdSec) : 0),
    0
  )
  return layer.startSec + playedBetween(content, content.inSec, clamped) + holdsBefore
}

// --- Keyframed transform (shared by preview + export) ------------------------

/** A layer's animatable transform values at one instant. `opacity` is 0..1
 *  (1 = fully visible; multiplies an image layer's base opacity). */
export interface LayerTransform {
  x: number
  y: number
  scale: number
  opacity: number
}

/**
 * The layer's effective transform at timeline time `t`: linear interpolation
 * between its keyframes (times relative to `startSec`), holding the first/last
 * outside the range; without keyframes, the static base transform. The preview
 * evaluates this per frame; the export bakes the same piecewise-linear ramps
 * into ffmpeg `t` expressions — keep them identical.
 */
export function layerTransformAt(layer: Layer, t: number): LayerTransform {
  const kfs = layer.keyframes
  if (!kfs || kfs.length === 0) return { x: layer.x, y: layer.y, scale: layer.scale, opacity: 1 }
  const sorted = [...kfs].sort((a, b) => a.tSec - b.tSec)
  const local = t - layer.startSec
  if (local <= sorted[0].tSec) return pick(sorted[0])
  const last = sorted[sorted.length - 1]
  if (local >= last.tSec) return pick(last)
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (local <= b.tSec) {
      const span = b.tSec - a.tSec
      const f = span > 0 ? (local - a.tSec) / span : 1
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        scale: a.scale + (b.scale - a.scale) * f,
        opacity: kfOpacity(a) + (kfOpacity(b) - kfOpacity(a)) * f
      }
    }
  }
  return pick(last)
}

/** A keyframe's opacity, defaulting the absent field to fully visible. */
export function kfOpacity(k: Pick<LayerKeyframe, 'opacity'>): number {
  const o = k.opacity
  return typeof o === 'number' && Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1
}

function pick(k: LayerKeyframe): LayerTransform {
  return { x: k.x, y: k.y, scale: k.scale, opacity: kfOpacity(k) }
}

/**
 * The layer's opacity keyframes as ABSOLUTE-time points for the export's
 * sendcmd intervals, or null when no keyframe actually changes opacity (all
 * absent/1) so the plain opaque pipeline can be kept.
 */
export function opacityKeyframePoints(layer: Layer): { t: number; o: number }[] | null {
  const kfs = layer.keyframes
  if (!kfs || kfs.length === 0) return null
  const sorted = [...kfs].sort((a, b) => a.tSec - b.tSec)
  if (sorted.every((k) => kfOpacity(k) >= 0.9995)) return null
  return sorted.map((k) => ({ t: layer.startSec + k.tSec, o: kfOpacity(k) }))
}

/**
 * Insert or replace a keyframe at `tSec` (an existing one within `eps` seconds
 * is replaced — a canvas drag at the playhead updates rather than stacking).
 * Returns a new sorted array.
 */
export function upsertKeyframe(
  kfs: LayerKeyframe[] | undefined,
  kf: LayerKeyframe,
  eps = 0.02
): LayerKeyframe[] {
  const kept = (kfs ?? []).filter((k) => Math.abs(k.tSec - kf.tSec) > eps)
  return [...kept, kf].sort((a, b) => a.tSec - b.tSec)
}

/** The background is the bottom-most (index 0) layer. */
export function isBackgroundId(layers: Layer[], id: string): boolean {
  return layers.length > 0 && layers[0].id === id
}

/** Index a brand-new layer should be inserted at: the front (top of the stack). */
export function frontIndex(layers: Layer[]): number {
  return layers.length
}

/** A human label for a layer (custom name, else derived from its content). */
export function layerLabel(layer: Layer): string {
  if (layer.name && layer.name.trim()) return layer.name.trim()
  const c = layer.content
  if (c.kind === 'text') return c.text.trim() || 'Text'
  if (c.kind === 'image') return 'Image'
  if (c.kind === 'layout') return 'Layout'
  if (c.kind === 'compound') return 'Compound clip'
  return 'Video'
}

/**
 * Reapply a new front-to-back order of the *visible* layers onto the full stack,
 * leaving layers that aren't visible at the current time pinned to their slots.
 * `visibleBackToFront` are the visible layer ids in their new back→front order.
 */
export function applyVisibleOrder(layers: Layer[], visibleBackToFront: string[]): Layer[] {
  const byId = new Map(layers.map((l) => [l.id, l]))
  const ordered = visibleBackToFront
    .map((id) => byId.get(id))
    .filter((l): l is Layer => l != null)
  const visibleSet = new Set(visibleBackToFront)
  let vi = 0
  return layers.map((l) => (visibleSet.has(l.id) ? ordered[vi++] ?? l : l))
}

/** Move the layer at `from` to index `to`, returning a new array. */
export function moveLayer(layers: Layer[], from: number, to: number): Layer[] {
  if (from === to || from < 0 || from >= layers.length || to < 0 || to >= layers.length) return layers
  const next = layers.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** True if some non-empty text layer is on screen during the first 3 seconds. */
export function hookCovered(layers: Layer[]): boolean {
  return layers.some(
    (l) =>
      l.content.kind === 'text' &&
      l.content.text.trim().length > 0 &&
      l.startSec < HOOK_WINDOW_SEC &&
      l.endSec > 0
  )
}

// --- Factories --------------------------------------------------------------

const DEFAULT_PILL: PillStyle = { enabled: true, color: '#000000cc', padPx: 18 }

/** Where a new media layer lands: the output frame, and the media's aspect (w/h)
 *  so it can start fitted to that frame. Absent = the 9:16 frame / scale 1. */
export interface PlaceIn {
  frame?: FrameRect
  aspect?: number
}

/** Scale that fits media into the frame it is placed in (1 when unknown). */
const placedFit = (place: PlaceIn): number =>
  place.aspect && place.aspect > 0 ? fitScale(place.aspect, place.frame) : 1

/** A frame-filling video layer placed at `startSec` for `durationSec`, centered
 *  and fitted to `place.frame` (contain). */
export function makeVideoLayer(
  id: string,
  mediaId: string,
  startSec: number,
  durationSec: number,
  opts: { mute?: boolean } & PlaceIn = {}
): Layer {
  const dur = Math.max(0.1, durationSec)
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(0, startSec) + dur,
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: placedFit(opts),
    content: { kind: 'video', mediaId, inSec: 0, outSec: dur, mute: opts.mute ?? false, gainDb: 0, crop: null }
  }
}

/** A centered image layer (~half the frame), for the given time window. */
export function makeImageLayer(
  id: string,
  mediaId: string,
  startSec: number,
  endSec: number,
  place: PlaceIn = {}
): Layer {
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: 0.5 * placedFit(place),
    content: { kind: 'image', mediaId, opacity: 1 }
  }
}

/** A default text layer placed at the given time window, a third of the way
 *  down the output frame. */
export function makeTextLayer(
  id: string,
  startSec: number,
  endSec: number,
  frame: FrameRect = FULL_FRAME
): Layer {
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: FRAME.width / 2,
    y: frame.y + frame.h * 0.32,
    scale: 1,
    content: {
      kind: 'text',
      text: 'Your hook here',
      fontFamily: DEFAULT_FONT_ID,
      fontSizePx: 76,
      color: '#ffffff',
      pill: { ...DEFAULT_PILL }
    }
  }
}

/** Narrow a layer's content to a kind (handy in TS-land render switches). */
export function contentOfKind<K extends LayerContent['kind']>(
  content: LayerContent,
  kind: K
): Extract<LayerContent, { kind: K }> | null {
  return content.kind === kind ? (content as Extract<LayerContent, { kind: K }>) : null
}
