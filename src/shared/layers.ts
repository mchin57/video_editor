/**
 * Pure, dependency-free helpers for the unified layer stack. Shared by the
 * preview (renderer) and the exporter (main) so placement/timing/stacking math
 * is computed identically on both sides. Coordinates are logical 1080x1920 px.
 */

import type { Layer, LayerContent, PillStyle, VideoContent } from './project'
import { DEFAULT_FONT_ID } from './fonts'

/** The single source of truth for the logical output space (1080x1920 px).
 *  Renderer code imports this as `LOGICAL` (see `lib/coords.ts`). @see docs/SHARED.md */
export const FRAME = { width: 1080, height: 1920 } as const
export const HOOK_WINDOW_SEC = 3

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

/** Total extra played time a video layer's freeze holds add (seconds). */
export function freezeExtraSec(content: VideoContent): number {
  return (content.freezes ?? []).reduce((sum, f) => sum + Math.max(0, f.holdSec), 0)
}

/**
 * Source-media time a video layer should show at timeline time `t`, honoring any
 * freeze holds. Played time runs `inSec → outSec` but pauses on each freeze's
 * source frame for its `holdSec`, so the played window is longer than the source
 * span by `freezeExtraSec`.
 */
export function videoSourceTime(content: VideoContent, layer: Layer, t: number): number {
  let local = t - layer.startSec // played time within the (stretched) layer
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  for (const f of freezes) {
    // Earlier holds are already removed from `local`, so this freeze sits at its
    // raw source distance from the in-point in the reduced timeline.
    const atPlayed = f.atSec - content.inSec
    if (local < atPlayed) break // freeze is still ahead — normal linear mapping
    if (local < atPlayed + f.holdSec) return clampSrc(content, f.atSec) // inside the hold
    local -= Math.max(0, f.holdSec) // passed it: drop its hold as dead played time
  }
  return clampSrc(content, content.inSec + local)
}

function clampSrc(content: VideoContent, s: number): number {
  return Math.min(content.outSec, Math.max(content.inSec, s))
}

/** True if timeline time `t` falls inside one of the layer's freeze holds. */
export function isFrozenAt(content: VideoContent, layer: Layer, t: number): boolean {
  let local = t - layer.startSec
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  for (const f of freezes) {
    const atPlayed = f.atSec - content.inSec
    if (local < atPlayed) return false
    if (local < atPlayed + f.holdSec) return true
    local -= Math.max(0, f.holdSec)
  }
  return false
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

/** A full-frame video layer placed at `startSec` for `durationSec`. */
export function makeVideoLayer(
  id: string,
  mediaId: string,
  startSec: number,
  durationSec: number,
  opts: { mute?: boolean } = {}
): Layer {
  const dur = Math.max(0.1, durationSec)
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(0, startSec) + dur,
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: 1,
    content: { kind: 'video', mediaId, inSec: 0, outSec: dur, mute: opts.mute ?? false, gainDb: 0, crop: null }
  }
}

/** A centered image layer (~half the frame), for the given time window. */
export function makeImageLayer(id: string, mediaId: string, startSec: number, endSec: number): Layer {
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: 0.5,
    content: { kind: 'image', mediaId, opacity: 1 }
  }
}

/** A default text layer placed at the given time window. */
export function makeTextLayer(id: string, startSec: number, endSec: number): Layer {
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: FRAME.width / 2,
    y: FRAME.height * 0.32,
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
