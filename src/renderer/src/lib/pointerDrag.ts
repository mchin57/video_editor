/**
 * Pointer-drag plumbing shared by every draggable surface (preview move/zoom,
 * caption move, crop/image-edit boxes, timeline blocks, splitters, layer
 * reordering). Replaces the hand-rolled window pointermove/pointerup
 * addEventListener + removeEventListener dance each handler repeated.
 *
 * Not a React hook (no state/effles) — call it directly from a pointer-down
 * handler. @see docs/SHARED.md
 */

import type { Project } from '@shared/project'
import { useProject } from '@/state/projectStore'

/**
 * Begin a drag: install window `pointermove`/`pointerup` listeners and tear them
 * down automatically on release. `onMove` fires for every move; optional `onUp`
 * fires once on release (after the listeners are removed).
 */
export function startPointerDrag(
  onMove: (ev: PointerEvent) => void,
  onUp?: (ev: PointerEvent) => void
): void {
  const move = (ev: PointerEvent): void => onMove(ev)
  const up = (ev: PointerEvent): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onUp?.(ev)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/**
 * Begin a project-mutating drag that records exactly ONE undo step: snapshots the
 * current project, runs `onMove` live (the caller uses `liveUpdate` inside it),
 * and commits the snapshot via `commitLive` on release. The snapshot is passed to
 * `onMove` so the handler can compute deltas from the pre-drag state.
 */
export function startDragWithUndo(onMove: (ev: PointerEvent, before: Project) => void): void {
  const before = useProject.getState().project
  if (!before) return
  startPointerDrag(
    (ev) => onMove(ev, before),
    () => useProject.getState().commitLive(before)
  )
}
