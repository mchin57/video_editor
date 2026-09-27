/**
 * The canonical logical space. Everything spatial in the project (layers,
 * captions, crops) is expressed in these 1080x1920 px; the project's output
 * format is a window on it (`FrameRect`, shared/frame.ts), so the same numbers
 * drive both the CSS-scaled preview stage and the ASS PlayRes on export.
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

/** Scale factor to render the logical stage into a container of given width. */
export function stageScale(containerWidthPx: number): number {
  return containerWidthPx / LOGICAL.width
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** True if a text bounding box intrudes into any of a format's platform UI safe
 *  zones (`ExportPreset.safeZones`). Box and zones must share a space — the
 *  zones are frame-relative, so pass a frame-relative box. */
export function intrudesSafeZone(box: Rect, zones: readonly Rect[]): boolean {
  return zones.some((z) => rectsOverlap(box, z))
}

/** Clamp a rect so it stays within the logical canvas. */
export function clampToCanvas(box: Rect): Rect {
  const x = Math.max(0, Math.min(box.x, LOGICAL.width - box.w))
  const y = Math.max(0, Math.min(box.y, LOGICAL.height - box.h))
  return { ...box, x, y }
}
