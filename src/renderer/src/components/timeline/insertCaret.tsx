/**
 * Timeline ▸ insert between: which seam a pointer is on, and the caret that
 * shows it. A drop from the Library on a seam, and a Shift-drag of a tile
 * released on one, INSERT there instead of placing on top — everything from the
 * seam on, on every lane, moves later (the rules are in lib/ripple.ts). The
 * caret spans all lanes because all of them move. e2e: insertBetween.spec.ts.
 */

import { useState, type JSX, type RefObject } from 'react'
import type { TimelineItemRef } from '@shared/project'
import { getActiveComp } from '@/state/projectStore'
import { laneAt, type LaneBox } from '@/lib/lanes'
import { refKey, refKeys, timelineTiles, type SourceDuration } from '@/lib/links'
import { seamNear } from '@/lib/ripple'
import { SNAP_PX, type LaneKey } from './constants'

export interface InsertCaretApi {
  /** The seam to draw the caret at (timeline seconds), or null for none. */
  caretSec: number | null
  /** The seam a Library drag is over (null = none). Drawn only while that drag
   *  is over the track, so an abandoned drag can't leave the caret behind. */
  showDropCaret: (sec: number | null) => void
  /** The seam a Shift-drag of a tile is over (null = none). */
  showDragCaret: (sec: number | null) => void
  /**
   * The seam under a pointer at (clientX, clientY), or null: where two tiles
   * meet in the lane the pointer is over, or the timeline start, within the
   * snap distance (`seamNear`). `skip` leaves out the tiles being dragged.
   */
  seamAt: (clientX: number, clientY: number, skip?: TimelineItemRef[]) => number | null
}

export function useInsertCaret({
  trackInnerRef,
  pxPerSec,
  lanes,
  srcDur,
  dropActive
}: {
  trackInnerRef: RefObject<HTMLDivElement | null>
  pxPerSec: number
  lanes: LaneBox<LaneKey>[]
  srcDur: SourceDuration
  /** Whether a Library drag is over the track right now. */
  dropActive: boolean
}): InsertCaretApi {
  const [dropSec, showDropCaret] = useState<number | null>(null)
  const [dragSec, showDragCaret] = useState<number | null>(null)
  const seamAt = (clientX: number, clientY: number, skip: TimelineItemRef[] = []): number | null => {
    const inner = trackInnerRef.current
    const comp = getActiveComp()
    if (!inner || !comp) return null
    const box = inner.getBoundingClientRect()
    const skipped = refKeys(skip)
    const tiles = timelineTiles(comp, srcDur).filter((t) => !skipped.has(refKey(t.ref)))
    return seamNear(tiles, laneAt(lanes, clientY - box.top), (clientX - box.left) / pxPerSec, SNAP_PX / pxPerSec)
  }
  return { caretSec: dragSec ?? (dropActive ? dropSec : null), showDropCaret, showDragCaret, seamAt }
}

/** The insert caret: a line across every lane at the seam. */
export function InsertCaret({ sec, pxPerSec }: { sec: number; pxPerSec: number }): JSX.Element {
  return (
    <div
      data-testid="insert-caret"
      className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 -translate-x-1/2 bg-lime-300 shadow-[0_0_6px_rgba(190,242,100,0.9)]"
      style={{ left: sec * pxPerSec }}
    >
      <span className="absolute left-1 top-0 whitespace-nowrap rounded bg-lime-300 px-1 text-[9px] font-semibold uppercase text-zinc-900">
        Insert
      </span>
    </div>
  )
}
