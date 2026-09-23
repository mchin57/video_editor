/**
 * The canonical logical space and the output-frame window on it.
 *
 * Deliberately a dependency-free LEAF module: `formats.ts` builds every
 * format's frame at load time, and `project.ts` (which `layers.ts` reaches
 * through `speed.ts`) imports `formats.ts` — so these primitives cannot live in
 * `layers.ts` without an init-order cycle. `layers.ts` re-exports all of it;
 * import from either.
 */

/** The single source of truth for the CANONICAL logical space (1080x1920 px) every
 *  layer, caption and keyframe is stored in. Renderer code imports this as
 *  `LOGICAL` (see `lib/coords.ts`). The visible output frame is a window on it —
 *  see `FrameRect`. @see docs/SHARED.md */
export const FRAME = { width: 1080, height: 1920 } as const

/** A rectangle in canonical logical px (top-left + size). */
export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The visible output frame of a `width`×`height` format: a window CENTRED on the
 * canonical FRAME. Layers never move when the format changes — only this window
 * does — so switching aspect ratio cannot lose data: whatever falls outside is
 * cropped on export and still in the project. A frame wider or taller than the
 * canonical space simply reaches into negative / beyond-1080 coordinates.
 * 1080×1920 is the identity window, which keeps every 9:16 number unchanged.
 * Formats are registered in `shared/formats.ts`.
 */
export function centeredFrame(width: number, height: number): FrameRect {
  return { x: (FRAME.width - width) / 2, y: (FRAME.height - height) / 2, w: width, h: height }
}

/** The 9:16 frame — the whole canonical space. */
export const FULL_FRAME: FrameRect = centeredFrame(FRAME.width, FRAME.height)

/**
 * Canonical → output pixel mapping for a raster that shows `frame` at
 * `outWidth` px wide. Uniform (`s` on both axes): logical px are square, and a
 * format's output size has the frame's aspect. The CSS twin is the preview's
 * frame canvas (`frameCanvasStyle`, PreviewStage); keep the two in step.
 */
export function frameToOutput(
  frame: FrameRect,
  outWidth: number
): { s: number; x: (x: number) => number; y: (y: number) => number } {
  const s = outWidth / frame.w
  return { s, x: (x) => (x - frame.x) * s, y: (y) => (y - frame.y) * s }
}
