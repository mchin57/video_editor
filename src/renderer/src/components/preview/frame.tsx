/** Preview ▸ the frame: the canonical canvas positioned behind the project's output window (`FrameCtx`, `frameCanvasStyle`) and the canonical-length CSS units. */

import { createContext, type CSSProperties } from 'react'
import type { AudioClip, Layer } from '@shared/project'
import { FULL_FRAME, type FrameRect } from '@shared/layers'
import { LOGICAL } from '@/lib/coords'

export const pct = (value: number, total: number): string => `${(value / total) * 100}%`
export const EMPTY_LAYERS: Layer[] = []
export const EMPTY_AUDIO: AudioClip[] = []
/** A logical-px length expressed in the container-query unit text is sized in, so
 *  fonts/strokes/shadows scale with the stage like the burned output does. The
 *  container is the canonical canvas (`frameCanvasStyle`), 1080 logical px wide. */
export const cqw = (px: number): string => `${(px / LOGICAL.width) * 100}cqw`
/** Vertical counterpart of `cqw`, for positioning by the logical y axis. */
export const cqh = (px: number): string => `${(px / LOGICAL.height) * 100}cqh`
/**
 * The project's output frame (a window on the canonical space — `shared/frame.ts`),
 * provided once by the stage so every level of the recursive render — root
 * stack, layouts, nested comps — resolves frame-relative geometry the same way.
 */
export const FrameCtx = createContext<FrameRect>(FULL_FRAME)
/**
 * The canonical 1080×1920 canvas, positioned inside a frame-shaped parent so
 * the parent shows exactly `frame`. Layers render inside it in canonical
 * coordinates (percentages of LOGICAL, `cqw`/`cqh` of this box), so nothing
 * about a layer changes with the format — the parent's `overflow: hidden` does
 * the cropping. The CSS twin of the export's `frameToOutput`. Identity in 9:16.
 */
export function frameCanvasStyle(frame: FrameRect): CSSProperties {
  return {
    position: 'absolute',
    left: pct(-frame.x, frame.w),
    top: pct(-frame.y, frame.h),
    width: pct(LOGICAL.width, frame.w),
    height: pct(LOGICAL.height, frame.h),
    containerType: 'size'
  }
}
