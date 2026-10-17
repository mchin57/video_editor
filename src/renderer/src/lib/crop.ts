/**
 * Crop math for fitting arbitrary source frames into the project's output aspect
 * (9:16 by default). Crop rectangles are stored in SOURCE/display pixels on each clip and
 * baked at export; the preview applies them with CSS. All pure + unit-tested.
 */

import type { CropRect } from '@shared/project'

/** The default crop aspect (9:16, the Reel frame); callers pass the project's. */
export const OUTPUT_ASPECT = 9 / 16

/** Largest centered crop of `aspect` (w/h) that fits inside srcW x srcH. */
export function defaultCrop(srcW: number, srcH: number, aspect = OUTPUT_ASPECT): CropRect {
  let w = srcW
  let h = w / aspect
  if (h > srcH) {
    h = srcH
    w = h * aspect
  }
  return {
    x: Math.round((srcW - w) / 2),
    y: Math.round((srcH - h) / 2),
    w: Math.round(w),
    h: Math.round(h)
  }
}

/** Clamp a crop rect inside the source bounds, preserving its size. */
export function clampCrop(crop: CropRect, srcW: number, srcH: number): CropRect {
  const w = Math.min(crop.w, srcW)
  const h = Math.min(crop.h, srcH)
  return {
    x: Math.max(0, Math.min(Math.round(crop.x), srcW - w)),
    y: Math.max(0, Math.min(Math.round(crop.y), srcH - h)),
    w: Math.round(w),
    h: Math.round(h)
  }
}

/**
 * Resize a crop from its top-left by a new width, keeping `aspect` and staying
 * within source bounds (used by the corner drag handle).
 */
export function resizeCrop(crop: CropRect, newW: number, srcW: number, srcH: number, aspect = OUTPUT_ASPECT): CropRect {
  const maxW = Math.min(srcW - crop.x, (srcH - crop.y) * aspect)
  const w = Math.max(40, Math.min(newW, maxW))
  return clampCrop({ x: crop.x, y: crop.y, w, h: w / aspect }, srcW, srcH)
}

/** True when the crop already covers the whole source frame (no real cropping). */
export function isFullFrame(crop: CropRect | null, srcW: number, srcH: number): boolean {
  if (!crop) return true
  return crop.x <= 0 && crop.y <= 0 && crop.w >= srcW && crop.h >= srcH
}
