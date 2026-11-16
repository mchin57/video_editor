/**
 * Timeline ▸ transitions on a video / image tile (#64): the WEDGE on a tile edge
 * that shows a transition (dragging it changes the length — one undo step,
 * `startTransitionDrag` in useTileDrags), the top-corner handles that pull a
 * plain fade out of a clip's start or end, and the right-click menu's
 * "Add transition ▸". The edits are in `lib/transitions.ts`.
 */

import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import type { Composition, Layer, TimelineItemRef } from '@shared/project'
import {
  pairOf,
  PAIR_KINDS,
  TRANSITION_KINDS,
  takesTransitions,
  transitionOf,
  type TransitionSide
} from '@shared/transitions'
import { transitionCandidate } from '@/lib/transitions'
import type { SourceDuration } from '@/lib/links'
import { useProject } from '@/state/projectStore'
import { MENU_SEPARATOR, type ContextMenuEntry } from '@/components/ui'

/** Fill colour of a wedge per kind (the triangle is the part still hidden). */
const WEDGE_FILL: Record<keyof typeof TRANSITION_KINDS, string> = {
  dissolve: 'rgba(196,181,253,0.55)',
  dipBlack: 'rgba(9,9,11,0.7)',
  dipWhite: 'rgba(255,255,255,0.6)',
  fade: 'rgba(252,211,77,0.5)'
}

const sideName = (side: TransitionSide): string => (side === 'in' ? 'in' : 'out')

/**
 * The wedges on one tile: for each side with a transition, a triangle over its
 * window (rising at the start, falling at the end), and for each side without
 * one, a small handle in the top corner that drags a fade out of the edge.
 */
export function TransitionWedges({
  layer,
  comp,
  pxPerSec,
  height,
  onDown
}: {
  layer: Layer
  comp: Composition
  pxPerSec: number
  height: number
  onDown: (e: ReactPointerEvent, side: TransitionSide) => void
}): JSX.Element | null {
  if (!takesTransitions(layer)) return null
  const tileW = Math.max(12, (layer.endSec - layer.startSec) * pxPerSec)
  return (
    <>
      {(['in', 'out'] as const).map((side) => {
        const tr = transitionOf(layer, side)
        if (!tr) {
          return (
            <div
              key={side}
              data-testid={`fade-handle-${side}-${layer.id}`}
              title={`Drag to fade ${sideName(side)}`}
              onPointerDown={(e) => onDown(e, side)}
              className={`absolute top-0 z-10 h-2 w-2 cursor-ew-resize bg-amber-300/0 opacity-0 group-hover:bg-amber-300/80 group-hover:opacity-100 ${
                side === 'in' ? 'left-1.5 rounded-br-sm' : 'right-1.5 rounded-bl-sm'
              }`}
            />
          )
        }
        const w = Math.min(tileW, tr.sec * pxPerSec)
        const pair = pairOf(comp.layers, layer.id, side)
        const label = `${TRANSITION_KINDS[tr.kind].label} ${sideName(side)} · ${tr.sec.toFixed(2)} s${
          pair ? '' : tr.kind === 'fade' ? '' : ' (no partner)'
        } — drag to change`
        const points = side === 'in' ? `0,0 ${w},0 0,${height}` : `0,0 ${w},0 ${w},${height}`
        return (
          <svg
            key={side}
            data-testid={`transition-wedge-${side}-${layer.id}`}
            data-kind={tr.kind}
            data-sec={tr.sec}
            onPointerDown={(e) => onDown(e, side)}
            className="absolute top-0 z-10 cursor-ew-resize"
            style={{ [side === 'in' ? 'left' : 'right']: 0, width: w, height }}
            width={w}
            height={height}
          >
            <title>{label}</title>
            <polygon points={points} fill={WEDGE_FILL[tr.kind]} />
            <line
              x1={0}
              y1={side === 'in' ? height : 0}
              x2={w}
              y2={side === 'in' ? 0 : height}
              stroke="rgba(255,255,255,0.85)"
              strokeWidth={1}
            />
          </svg>
        )
      })}
    </>
  )
}

/**
 * The right-click menu rows for a video / image tile: "Add transition ▸" (the
 * pair kinds; enabled when the selection is two neighbouring clips — a
 * right-press has already selected the tile, or kept the selection it belongs
 * to) and a Remove row per transition the tile has. Built at open time.
 */
export function transitionMenu(
  comp: Composition,
  layer: Layer,
  selection: TimelineItemRef[],
  srcDur: SourceDuration
): ContextMenuEntry[] {
  if (!takesTransitions(layer)) return []
  const check = transitionCandidate(comp, selection)
  const store = useProject.getState()
  const rows: ContextMenuEntry[] = [
    {
      label: 'Add transition',
      testId: 'ctx-add-transition',
      ...(check.ok
        ? {
            submenu: PAIR_KINDS.map((kind): ContextMenuEntry => ({
              label: TRANSITION_KINDS[kind].label,
              testId: `ctx-transition-${kind}`,
              onSelect: () => void store.applyTransition(selection, kind, srcDur)
            }))
          }
        : { disabled: true, reason: check.reason })
    }
  ]
  const removable = (['in', 'out'] as const).filter((side) => transitionOf(layer, side))
  if (removable.length > 0) rows.push(MENU_SEPARATOR)
  for (const side of removable) {
    const tr = transitionOf(layer, side)!
    rows.push({
      label: `Remove ${TRANSITION_KINDS[tr.kind].label.toLowerCase()} ${sideName(side)}`,
      testId: `ctx-remove-transition-${side}`,
      onSelect: () => store.removeTransition(layer.id, side)
    })
  }
  return rows
}
