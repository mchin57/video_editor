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
import { beginInteraction } from './interaction'

/**
 * Begin a drag: install window `pointermove`/`pointerup` listeners and tear them
 * down automatically on release. `onMove` fires for every move; optional `onUp`
 * fires once on release (after the listeners are removed).
 *
 * `pointercancel` (window focus loss, OS gesture stealing the pointer) is
 * treated as a release — without it the move listener leaks, the drag's undo
 * step is never committed, and any rAF loop stopped in `onUp` spins forever.
 *
 * The drag holds the interaction lock (`lib/interaction.ts`) from here until
 * release, AFTER `onUp` has committed — so assistant calls wait for it and
 * keyboard shortcuts are ignored instead of being overwritten by the next move.
 */
export function startPointerDrag(
  onMove: (ev: PointerEvent) => void,
  onUp?: (ev: PointerEvent) => void
): void {
  const end = beginInteraction()
  const move = (ev: PointerEvent): void => onMove(ev)
  const up = (ev: PointerEvent): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    try {
      onUp?.(ev)
    } finally {
      end() // even if onUp throws: a lock left open would hold every assistant call
    }
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
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

/** px from an edge where auto-scroll kicks in. */
export const EDGE_SCROLL_ZONE = 40
/** px/frame while auto-scrolling — FLAT, see `edgeScrollDir`. */
export const EDGE_SCROLL_SPEED = 12

/**
 * Which way a pointer at `p` drags an axis spanning `lo`..`hi`: -1 (toward the
 * start), +1 (toward the end), or 0 (not scrolling).
 *
 * The zone is a GATE, not a throttle — inside it, or past the edge entirely, the
 * answer is the same ±1. Scaling speed with edge proximity (as this once did)
 * made the same hand movement scroll a different distance depending on where in
 * the 40px band it landed, so a drag accelerated away from the user and
 * overshooting was near-impossible to correct. Keep this returning a DIRECTION;
 * if it ever returns a magnitude again, the ramp is back.
 */
export function edgeScrollDir(p: number, lo: number, hi: number, zone = EDGE_SCROLL_ZONE): number {
  if (p < lo + zone) return -1
  if (p > hi - zone) return 1
  return 0
}

/**
 * Auto-scrolls a container while a drag hovers near an edge. Feed the pointer's
 * X and/or Y on every move (`setX`/`setY`; an axis stays off until first fed); a
 * rAF loop nudges `scrollLeft`/`scrollTop` at a constant rate and calls
 * `onScroll` after each real nudge, so the drag handler can re-apply its
 * position (which reads the live scroll offset). Horizontal callers (timeline
 * block drags) use only `setX`; the vertical lane-resize uses only `setY`.
 * Returns `setX`/`setY`/`stop`; the loop starts immediately.
 */
export function edgeAutoScroll(
  el: HTMLElement,
  onScroll: () => void
): { setX: (x: number) => void; setY: (y: number) => void; stop: () => void } {
  let x = -1
  let y = -1
  let raf = 0
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const rect = el.getBoundingClientRect()
    let scrolled = false
    const nudge = (v: number, read: () => number, write: (n: number) => void): void => {
      if (v === 0) return
      const before = read()
      write(Math.max(0, before + v))
      if (read() !== before) scrolled = true
    }
    if (x >= 0) {
      nudge(
        edgeScrollDir(x, rect.left, rect.right) * EDGE_SCROLL_SPEED,
        () => el.scrollLeft,
        (n) => (el.scrollLeft = n)
      )
    }
    if (y >= 0) {
      nudge(
        edgeScrollDir(y, rect.top, rect.bottom) * EDGE_SCROLL_SPEED,
        () => el.scrollTop,
        (n) => (el.scrollTop = n)
      )
    }
    if (scrolled) onScroll()
  }
  raf = requestAnimationFrame(tick)
  return {
    setX: (nx: number) => {
      x = nx
    },
    setY: (ny: number) => {
      y = ny
    },
    stop: () => cancelAnimationFrame(raf)
  }
}
