/**
 * Free-angle rotation — ONE model for every visual (video, image and text
 * layers via `Layer.rotationDeg`, captions via `CaptionStyle.rotationDeg`).
 *
 * Conventions everywhere: degrees, CLOCKWISE positive in screen space (y down),
 * about the box centre. That is CSS `rotate()`, libass `\frz` with the sign
 * flipped, and ffmpeg `rotate=a=` in radians (verified — FFMPEG-NOTES "Layer
 * rotation"). The rotate handle, the rotated resize and the export all build
 * from these helpers so the three can't drift apart.
 * @see docs/SHARED.md
 */

import { resizeBox, type ResizeBox, type ResizeHandle } from './layers'

/** Fold any angle into (-180, 180]. `-0` comes back as `0`. */
export function normalizeDeg(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  else if (d <= -180) d += 360
  return d === 0 ? 0 : d
}

/** Rotate the vector (x, y) CLOCKWISE by `deg` in screen space (y down). */
export function rotateVec(x: number, y: number, deg: number): { x: number; y: number } {
  if (!deg) return { x, y }
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: x * c - y * s, y: x * s + y * c }
}

/** Size of the axis-aligned box that holds a w×h box rotated by `deg` — what
 *  ffmpeg's `rotw(a)`/`roth(a)` return. */
export function rotatedBounds(w: number, h: number, deg: number): { w: number; h: number } {
  const a = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const s = Math.abs(Math.sin(a))
  return { w: w * c + h * s, h: w * s + h * c }
}

/** The pointer's direction from the box centre, measured CLOCKWISE FROM
 *  STRAIGHT UP — so a rotate handle sitting above an unrotated box reads 0. */
export function pointerAngleDeg(cx: number, cy: number, px: number, py: number): number {
  return (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI
}

/** Free drags snap to a right angle within this many degrees of one. */
export const ROTATE_SNAP_DEG = 5
/** Shift-drag step. */
export const ROTATE_STEP_DEG = 15

/**
 * The angle a rotate-handle drag lands on. The drag is RELATIVE — the box turns
 * by how far the pointer has swept around the centre since the drag began — so
 * grabbing the handle never makes the box jump. `step` (Shift) rounds to 15°
 * steps; otherwise the result snaps to 0/90/180/270 when within
 * `ROTATE_SNAP_DEG` of one. Always normalised.
 */
export function rotateDragDeg(
  startDeg: number,
  startPointerDeg: number,
  pointerDeg: number,
  step = false
): number {
  const raw = normalizeDeg(startDeg + (pointerDeg - startPointerDeg))
  if (step) return normalizeDeg(Math.round(raw / ROTATE_STEP_DEG) * ROTATE_STEP_DEG)
  const right = Math.round(raw / 90) * 90
  return normalizeDeg(Math.abs(raw - right) <= ROTATE_SNAP_DEG ? right : raw)
}

/**
 * `resizeBox` for a box rotated by `deg`: the screen-space drag (dx, dy) is
 * turned into the box's OWN axes first, so an edge handle stretches along the
 * box's side and the opposite edge stays put on screen. At 0° this is exactly
 * `resizeBox`. `box.cx/cy` is the (rotation-invariant) centre; `w/h` the
 * UNROTATED size.
 */
export function resizeRotatedBox(
  box: ResizeBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  aspect: boolean,
  deg: number,
  minSize?: number
): ResizeBox {
  if (!deg) return resizeBox(box, handle, dx, dy, aspect, minSize)
  const local = rotateVec(dx, dy, -deg)
  const r = resizeBox({ cx: 0, cy: 0, w: box.w, h: box.h }, handle, local.x, local.y, aspect, minSize)
  // The centre shift happened in local axes; turn it back onto the screen.
  const off = rotateVec(r.cx, r.cy, deg)
  return { cx: box.cx + off.x, cy: box.cy + off.y, w: r.w, h: r.h }
}

/** Where `handle` sits on a w×h box rotated by `deg`, relative to its centre.
 *  `'rot'` is the top-middle anchor the rotate handle hangs off. */
export function handleOffset(
  w: number,
  h: number,
  handle: ResizeHandle | 'rot',
  deg: number
): { x: number; y: number } {
  const hx = handle === 'rot' ? 0 : handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const hy = handle === 'rot' ? -1 : handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  return rotateVec((hx * w) / 2, (hy * h) / 2, deg)
}
