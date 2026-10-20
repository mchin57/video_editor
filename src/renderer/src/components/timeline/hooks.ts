/**
 * Timeline ▸ the panel's view state and the effects that keep it in step:
 * persisted zoom / follow mode / lane sizes, the scroll pins that stop a drag
 * shrinking the track under itself, Ctrl+wheel zoom, playhead follow, the
 * gutter following a vertical scroll, and the hovered tile's description box.
 * Guarded by e2e/timelineInteractions.spec.ts and edgeScrollShrink.spec.ts.
 */

import { useEffect, useState, type JSX, type RefObject } from 'react'
import type { MediaAsset } from '@shared/media'
import { clamp } from '@shared/math'
import { useHoverIntent } from '@/hooks/useHoverIntent'
import { usePersistedState } from '@/hooks/usePersistedState'
import { interactionOpen } from '@/lib/interaction'
import { edgeAutoScroll } from '@/lib/pointerDrag'
import type { LaneViewPref } from '@/lib/lanes'
import { FOLLOW_PREF, PPS_PREF, VIEW_PREF, type FollowMode, type LaneKey, type TimelineView } from './constants'
import type { TileDescriptionAt } from './TileDescription'
import { useLatest } from '@/hooks/useLatest'

/** Zoom (px per second), playhead follow mode and per-lane height / collapse —
 *  view preferences persisted in localStorage. The refs hold the latest values
 *  for listeners registered once (the wheel handler). */
export function useTimelineView(): {
  pxPerSec: number
  setPxPerSec: (next: number | ((p: number) => number)) => void
  pxPerSecRef: RefObject<number>
  followMode: FollowMode
  setFollowMode: (mode: FollowMode) => void
  followModeRef: RefObject<FollowMode>
  laneView: TimelineView
  patchLane: (key: LaneKey, patch: LaneViewPref) => void
  toggleLaneCollapsed: (key: LaneKey) => void
} {
  const [pxPerSec, setPxPerSec] = usePersistedState('timelinePps', PPS_PREF)
  const pxPerSecRef = useLatest(pxPerSec)

  const [followMode, setFollowMode] = usePersistedState('timelineFollow', FOLLOW_PREF)
  const followModeRef = useLatest(followMode)

  // Per-lane height / collapse prefs, persisted across reloads.
  const [laneView, setLaneView] = usePersistedState('timelineView', VIEW_PREF)
  const patchLane = (key: LaneKey, patch: LaneViewPref): void =>
    setLaneView((v) => ({ ...v, [key]: { ...v[key], ...patch } }))
  const toggleLaneCollapsed = (key: LaneKey): void =>
    setLaneView((v) => ({ ...v, [key]: { ...v[key], collapsed: !v[key]?.collapsed } }))

  return {
    pxPerSec,
    setPxPerSec,
    pxPerSecRef,
    followMode,
    setFollowMode,
    followModeRef,
    laneView,
    patchLane,
    toggleLaneCollapsed
  }
}

/**
 * Pins that stop the track shrinking under a live drag. `naturalW` is the
 * track's width from its content alone.
 *
 * While a lane resize is shrinking the track, the scrollable HEIGHT is pinned
 * to the tallest it reached this drag (`resizeFloorH`), so the browser can't
 * clamp scrollTop out from under the drag (which would feed back into the
 * height and run away). 0 = idle.
 *
 * `dragFloorW` is the horizontal twin, for the same reason. The track's width
 * is derived from the content, so dragging the RIGHTMOST tile leftwards shrinks
 * the scrollable area under the drag: the browser then clamps `scrollLeft` down
 * to the new maximum, that clamp feeds straight into the drag's `dx` (which
 * adds the live `scrollLeft`), the tile jumps further left, and the width
 * shrinks again — a runaway that reads as the edge-scroll accelerating even
 * though its rate is flat. Pinning the width breaks the loop.
 *
 * It must be a HIGH-WATER MARK maintained for the whole drag, not a snapshot
 * taken at grab time: drag right and the natural width grows past a stale
 * floor, so dragging back left without releasing is free to shrink again
 * through that band and the runaway returns.
 */
export function useScrollPins(naturalW: number): {
  resizeFloorH: number
  setResizeFloorH: (next: number | ((f: number) => number)) => void
  dragFloorW: number
  startEdgeScrollX: (sc: HTMLElement, onScroll: () => void) => { setX: (x: number) => void; stop: () => void }
} {
  const [resizeFloorH, setResizeFloorH] = useState(0)
  const [dragFloorW, setDragFloorW] = useState(0)
  // Gates the ratchet below; cleared on release, when the track settles to its content.
  const [draggingX, setDraggingX] = useState(false)

  // Ratchet the floor up while a horizontal drag is live, so the pin tracks the
  // widest the track has been THIS drag (drag right, then left without
  // releasing). Adjusted while rendering: it only ever rises to `naturalW`.
  if (draggingX && naturalW > dragFloorW) setDragFloorW(naturalW)

  /**
   * Start the edge auto-scroller for a HORIZONTAL drag, pinning the track's
   * scrollable width for the drag's lifetime. Every horizontal drag goes
   * through this rather than `edgeAutoScroll` directly, so none of them can
   * re-open the shrink runaway; the vertical lane resize keeps calling
   * `edgeAutoScroll` itself and pins the HEIGHT instead. Releasing the pin
   * rides on the `stop()` every caller already runs in its `onUp`.
   */
  const startEdgeScrollX = (sc: HTMLElement, onScroll: () => void): { setX: (x: number) => void; stop: () => void } => {
    // Arm the ratchet; the effect above seeds and then maintains the floor from
    // the live content width, so it keeps up with a drag that reverses.
    setDraggingX(true)
    const s = edgeAutoScroll(sc, onScroll)
    return {
      setX: s.setX,
      stop: () => {
        s.stop()
        setDraggingX(false)
        setDragFloorW(0) // release; the track settles to its true width
      }
    }
  }

  return { resizeFloorH, setResizeFloorH, dragFloorW, startEdgeScrollX }
}

/** Ctrl/Cmd + wheel = horizontal zoom anchored at the cursor. A plain
 *  horizontal wheel is swallowed while CENTERED follow owns the scroll during
 *  playback (vertical lane scrolling stays live). */
export function useWheelZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  pxPerSecRef: RefObject<number>,
  setPxPerSec: (next: number) => void,
  followModeRef: RefObject<FollowMode>,
  playingRef: RefObject<boolean>
): void {
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) {
        // Centered follow owns the horizontal scroll during playback — swallow
        // user horizontal wheel so it doesn't fight the auto-scroll (vertical
        // lane scrolling stays live).
        if (
          followModeRef.current === 'centered' &&
          playingRef.current &&
          (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
        ) {
          e.preventDefault()
        }
        return
      }
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const cur = pxPerSecRef.current
      const timeAtCursor = (el.scrollLeft + cursorX) / cur
      const next = clamp(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 8, 240)
      if (next === cur) return
      setPxPerSec(next)
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, timeAtCursor * next - cursorX)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scrollRef, pxPerSecRef, setPxPerSec, followModeRef, playingRef]) // all stable
}

/** Playhead follow: while playing, keep the playhead in view per the selected
 *  mode. Runs on every playback tick (time updates each rAF), so user scrolls
 *  in centered mode are re-asserted away within a frame. */
export function usePlayheadFollow(
  scrollRef: RefObject<HTMLDivElement | null>,
  time: number,
  playing: boolean,
  followMode: FollowMode,
  pxPerSec: number
): void {
  useEffect(() => {
    if (!playing || followMode === 'none') return
    const el = scrollRef.current
    if (!el) return
    const x = time * pxPerSec
    if (followMode === 'centered') {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
    } else {
      // Page jump: playhead exits the visible span → snap it back to the left
      // edge (a page forward when it ran off the right, straight there on seeks).
      const margin = 8
      if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft) {
        el.scrollLeft = Math.max(0, x - margin)
      }
    }
  }, [scrollRef, time, playing, followMode, pxPerSec])
}

/** Keep the fixed lane-header gutter aligned as the track scrolls vertically. */
export function useGutterSync(
  scrollRef: RefObject<HTMLDivElement | null>,
  gutterRef: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const sync = (): void => {
      const g = gutterRef.current
      if (g) g.style.transform = `translateY(${-el.scrollTop}px)`
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [scrollRef, gutterRef])
}

/**
 * Hovering a media tile (video, image, audio) shows its clip's description
 * above it (`TileDescription`). A short open delay, so sweeping across tiles
 * doesn't flash a box over each. The box closes when the tiles move under it
 * (a scroll or zoom anywhere but inside the box, or a resize).
 */
export function useTileDescriptionHover(assetById: Map<string, MediaAsset>): {
  descHover: ReturnType<typeof useHoverIntent<TileDescriptionAt>>
  descAsset: MediaAsset | undefined
  /** The hover wiring for a tile showing library clip `asset` (none without one). */
  descHoverProps: (asset: MediaAsset | undefined) => Partial<JSX.IntrinsicElements['div']>
} {
  const descHover = useHoverIntent<TileDescriptionAt>({ openMs: 400 })
  const descHoverProps = (asset: MediaAsset | undefined): Partial<JSX.IntrinsicElements['div']> =>
    asset
      ? {
          // A press (select, drag, trim) closes it.
          onPointerDownCapture: () => descHover.intent.close(),
          onMouseEnter: (e) => {
            // Not mid-drag (any drag: a tile, a trim, the playhead).
            if (interactionOpen()) return
            const el = e.currentTarget
            descHover.intent.enter({ mediaId: asset.id, el, rect: el.getBoundingClientRect(), x: e.clientX })
          },
          onMouseLeave: () => descHover.intent.leave()
        }
      : {}
  const descAsset = descHover.target ? assetById.get(descHover.target.mediaId) : undefined
  // The tiles move under a scroll or zoom: drop the box rather than leave it floating.
  // A wheel inside the box scrolls its text instead (the box is portaled, so the
  // tiles don't move under it); it closes only when the mouse leaves.
  useEffect(() => {
    if (!descHover.target) return undefined
    const close = (): void => descHover.intent.close()
    const onWheel = (e: WheelEvent): void => {
      if (e.target instanceof Element && e.target.closest('[data-description-panel]')) return
      close()
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [descHover.target, descHover.intent])
  return { descHover, descAsset, descHoverProps }
}
