/** Preview ▸ canvas handles: resize / rotate handles and the motion-path dots. */

import { type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { type FrameRect, type ResizeHandle } from '@shared/layers'
import { type ResizeHandleSet } from '@shared/layerKinds'
import { handleOffset, rotateVec } from '@shared/rotation'
import { clamp } from '@shared/math'
import { pct } from './frame'
import { MeasuredBox } from './geometry'

// Media gets all 8 handles; text only the 4 corners + left/right sides (its
// height is automatic, so top/bottom handles have nothing to resize). Layouts
// get corners only — cells resolve through `scale` and ignore stretch, so edge
// handles would silently do nothing.
const MEDIA_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const TEXT_HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw', 'e', 'w']
const CORNER_HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw']
/** Each kind's handle set (`LayerKindInfo.handles`). */
export const HANDLE_SETS: Record<ResizeHandleSet, ResizeHandle[]> = {
  media: MEDIA_HANDLES,
  text: TEXT_HANDLES,
  corners: CORNER_HANDLES
}
/** Resize cursor for a handle on a box rotated by `deg`: the handle's outward
 *  direction, turned with the box, picks the nearest of the four cursors. */
const HANDLE_DIR_DEG: Record<ResizeHandle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }
const RESIZE_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize']
const handleCursor = (h: ResizeHandle, deg = 0): string =>
  RESIZE_CURSORS[((Math.round((HANDLE_DIR_DEG[h] + deg) / 45) % 4) + 4) % 4]
/** On-screen gap between the box's top edge and the rotate handle. */
const ROTATE_HANDLE_GAP_PX = 22
/** The edge/corner resize handles drawn on the selected layer's box. Positioned
 *  in a non-scaled overlay over the FRAME (so they stay a constant size and are
 *  not clipped by it), driven by the measured box; `onStart` begins the drag for
 *  the grabbed handle.
 *
 *  A handle whose true spot lies outside the frame — a 9:16 clip in a 16:9 or
 *  square frame reaches well past the top and bottom — is pinned to the frame
 *  edge instead, so every clip stays resizable whatever its aspect. The drag
 *  math uses pointer DELTAS against the real box (`resizeBox`), so a pinned
 *  handle resizes exactly like the real corner would. */
export function ResizeHandles({
  box,
  frame,
  handles,
  onStart,
  onRotateStart
}: {
  box: MeasuredBox
  frame: FrameRect
  handles: ResizeHandle[]
  onStart?: (e: ReactPointerEvent, handle: ResizeHandle) => void
  /** Present = the box can rotate: draws the rotate handle. */
  onRotateStart?: (e: ReactPointerEvent) => void
}): JSX.Element {
  const deg = box.rotationDeg
  return (
    <div className="pointer-events-none absolute inset-0 z-[450]">
      {onStart &&
        handles.map((h) => {
          // Handles sit on the ROTATED box, so they turn with it.
          const off = handleOffset(box.w, box.h, h, deg)
          const x = box.cx + off.x
          const y = box.cy + off.y
          const px = clamp(x, frame.x, frame.x + frame.w)
          const py = clamp(y, frame.y, frame.y + frame.h)
          return (
            <span
              key={h}
              data-handle={h}
              data-pinned={px !== x || py !== y ? '' : undefined}
              onPointerDown={(e) => onStart(e, h)}
              style={{
                left: pct(px - frame.x, frame.w),
                top: pct(py - frame.y, frame.h),
                cursor: handleCursor(h, deg)
              }}
              className="pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-sky-500 bg-white shadow"
            />
          )
        })}
      {onRotateStart && <RotateHandle box={box} frame={frame} onStart={onRotateStart} />}
    </div>
  )
}
/**
 * THE rotate handle — one implementation for video, image, text and captions.
 * It hangs off the middle of the box's top edge, a constant on-screen gap
 * outward, and turns with the box (at 90° clockwise it sits to the box's right).
 * When that spot would fall outside the frame (a clip that fills a 9:16 frame
 * has its top edge ON the frame edge) it flips to just inside the edge instead,
 * so it is always grabbable — the rotate twin of the resize handles' pinning.
 */
function RotateHandle({
  box,
  frame,
  onStart
}: {
  box: MeasuredBox
  frame: FrameRect
  onStart: (e: ReactPointerEvent) => void
}): JSX.Element {
  const anchor = handleOffset(box.w, box.h, 'rot', box.rotationDeg)
  const gap = ROTATE_HANDLE_GAP_PX / box.pxPerLogical
  const up = rotateVec(0, -gap, box.rotationDeg)
  const inFrame = (x: number, y: number): boolean =>
    x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h
  let x = box.cx + anchor.x + up.x
  let y = box.cy + anchor.y + up.y
  const inward = !inFrame(x, y)
  if (inward) {
    x = box.cx + anchor.x - up.x
    y = box.cy + anchor.y - up.y
  }
  x = clamp(x, frame.x, frame.x + frame.w)
  y = clamp(y, frame.y, frame.y + frame.h)
  return (
    <span
      data-handle="rotate"
      data-inward={inward ? '' : undefined}
      title="Drag to rotate (Shift: 15° steps)"
      onPointerDown={onStart}
      style={{ left: pct(x - frame.x, frame.w), top: pct(y - frame.y, frame.h), cursor: 'grab' }}
      className="pointer-events-auto absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sky-500 bg-white text-[10px] leading-none text-sky-600 shadow"
    >
      ⟳
    </span>
  )
}
/**
 * The selected layer's straight-line move, drawn on the canvas: a dashed line
 * from the start point (hollow dot) to the end point (filled dot). Dragging a
 * dot moves that end only. Positions are canonical logical px, drawn over the
 * frame like the resize handles (and pinned to its edge the same way when an
 * end lies outside it).
 */
export function MotionPath({
  motion,
  frame,
  onStart
}: {
  motion: { x0: number; y0: number; x1: number; y1: number }
  frame: FrameRect
  onStart: (e: ReactPointerEvent, end: 0 | 1) => void
}): JSX.Element {
  const dot = (end: 0 | 1): JSX.Element => {
    const x = end === 0 ? motion.x0 : motion.x1
    const y = end === 0 ? motion.y0 : motion.y1
    const px = clamp(x, frame.x, frame.x + frame.w)
    const py = clamp(y, frame.y, frame.y + frame.h)
    return (
      <span
        key={end}
        data-motion={end === 0 ? 'start' : 'end'}
        data-pinned={px !== x || py !== y ? '' : undefined}
        title={end === 0 ? 'Motion start — drag to move' : 'Motion end — drag to move'}
        onPointerDown={(e) => onStart(e, end)}
        style={{ left: pct(px - frame.x, frame.w), top: pct(py - frame.y, frame.h), cursor: 'move' }}
        className={`pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400 shadow ${
          end === 0 ? 'bg-black/40' : 'bg-amber-400'
        }`}
      />
    )
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-[440]" data-testid="motion-path">
      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
        preserveAspectRatio="none"
      >
        <line
          x1={motion.x0}
          y1={motion.y0}
          x2={motion.x1}
          y2={motion.y1}
          stroke="#fbbf24"
          strokeWidth={2}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {dot(0)}
      {dot(1)}
    </div>
  )
}
