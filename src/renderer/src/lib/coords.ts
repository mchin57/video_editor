/**
 * The logical output space. Everything spatial in the project (overlays,
 * captions, crops, safe zones) is expressed in these 1080x1920 px so the same
 * numbers drive both the CSS-scaled preview stage and the ASS PlayRes on export.
 *
 * This is an alias of the shared `FRAME` (the single source of truth, importable
 * by main + renderer); kept under the `LOGICAL` name for the renderer call-sites.
 */

import { FRAME } from '@shared/layers'

export const LOGICAL = FRAME

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Instagram UI safe zones (regions to keep text OUT of), in logical px.
 * Bottom ~25% holds the caption/CTA/audio UI; the right ~10% is the action rail.
 */
export const SAFE_ZONES = {
  bottom: { x: 0, y: 1440, w: 1080, h: 480 } satisfies Rect,
  rightRail: { x: 972, y: 0, w: 108, h: 1920 } satisfies Rect
} as const

/** Scale factor to render the logical stage into a container of given width. */
export function stageScale(containerWidthPx: number): number {
  return containerWidthPx / LOGICAL.width
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** True if a text bounding box intrudes into any Instagram safe zone. */
export function intrudesSafeZone(box: Rect): boolean {
  return rectsOverlap(box, SAFE_ZONES.bottom) || rectsOverlap(box, SAFE_ZONES.rightRail)
}

/** Clamp a rect so it stays within the logical canvas. */
export function clampToCanvas(box: Rect): Rect {
  const x = Math.max(0, Math.min(box.x, LOGICAL.width - box.w))
  const y = Math.max(0, Math.min(box.y, LOGICAL.height - box.h))
  return { ...box, x, y }
}
