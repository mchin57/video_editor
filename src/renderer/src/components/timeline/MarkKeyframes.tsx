/**
 * Timeline ▸ the selected graphics mark's keyframes as diamonds along the
 * bottom of a SELECTED graphics tile (`x = tSec × pxPerSec`; keyframes off the
 * tile are skipped). A diamond at an edge is DRAWN clamped inside the tile (and
 * stacked above the trim handles) so it can be grabbed; its true time is what
 * click/drag/double-click act on. Only the diamonds take the pointer, so the
 * rest of the tile still moves and trims it. Click = pick it (Delete then removes just it) and move the playhead there; drag =
 * retime it (every move is computed from the mark as it was at the press, so
 * the index stays valid, and the keyframe stops 0.03 s short of a neighbour
 * rather than crossing or landing on it); double-click = remove it. Each
 * gesture is ONE undo step (`liveUpdate` while dragging, `commitLive` on
 * release; a drag that ends where it began records nothing). The edits are `shared/markAnim.ts`.
 */

import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import type { GraphicMark } from '@shared/graphics'
import { removeMarkKeyframe, retimeMarkKeyframe } from '@shared/markAnim'
import type { Layer } from '@shared/project'
import { updateById } from '@/lib/arrays'
import {
  clampBetweenNeighbours,
  clampKeyframeX,
  DIAMOND_PX,
  keyframeAtPlayhead,
  keyframeX,
  pickedKeyframeIndex,
  visibleKeyframes,
  xToKeyframeSec
} from '@/lib/markKeyframes'
import { startPointerDrag } from '@/lib/pointerDrag'
import { getActiveComp, useProject } from '@/state/projectStore'
import { mapGraphicsMarks } from '@/state/project/core'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { CLICK_SLOP } from './constants'

/** The mark `markId` on graphics layer `layerId` as the store has it now. */
function currentMark(layerId: string, markId: string): GraphicMark | undefined {
  const l = getActiveComp()?.layers.find((x) => x.id === layerId)
  return l && l.content.kind === 'graphics' ? l.content.marks.find((m) => m.id === markId) : undefined
}

export function MarkKeyframeDiamonds({ layer, pxPerSec }: { layer: Layer; pxPerSec: number }): JSX.Element | null {
  const markId = useUi((s) => s.selectedMarkId)
  const time = usePlayback((s) => s.time)
  const picked = useUi((s) => s.selectedMarkKeyframe)
  if (layer.content.kind !== 'graphics' || !markId) return null
  const mark = layer.content.marks.find((m) => m.id === markId)
  if (!mark?.keyframes || mark.keyframes.length === 0) return null

  const lenSec = layer.endSec - layer.startSec
  const tileWidth = Math.max(12, lenSec * pxPerSec)
  const comp = getActiveComp()
  const pickedIndex =
    comp && picked && picked.layerId === layer.id && picked.markId === mark.id ? pickedKeyframeIndex(comp, picked) : -1
  const shown = visibleKeyframes(mark.keyframes, lenSec)
  const atIndex = keyframeAtPlayhead(mark.keyframes, time - layer.startSec)

  const live = (next: GraphicMark): void =>
    useProject.getState().liveUpdate((c) => mapGraphicsMarks(c, layer.id, (ms) => updateById(ms, mark.id, () => next)))

  const onDown = (e: ReactPointerEvent, index: number): void => {
    // The tile underneath must not start a move, nor the track a scrub.
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    const snapshot = currentMark(layer.id, mark.id)
    const before = useProject.getState().project
    if (!snapshot?.keyframes || !before) return
    const t0 = snapshot.keyframes[index].tSec
    const x0 = e.clientX
    let dragged = false
    useUi.getState().selectMarkKeyframe({ layerId: layer.id, markId: mark.id, tSec: t0 })
    startPointerDrag(
      (ev) => {
        const dx = ev.clientX - x0
        if (!dragged && Math.abs(dx) <= CLICK_SLOP) return
        dragged = true
        const next = retimeMarkKeyframe(
          snapshot,
          index,
          clampBetweenNeighbours(snapshot.keyframes!, index, t0 + xToKeyframeSec(dx, pxPerSec)),
          lenSec
        )
        if (next === snapshot) return // refused (onto a neighbour): keep the last accepted state
        live(next)
        useUi.getState().selectMarkKeyframe({ layerId: layer.id, markId: mark.id, tSec: next.keyframes![index].tSec })
      },
      () => {
        if (!dragged) usePlayback.getState().setTime(layer.startSec + t0)
        else {
          const now = currentMark(layer.id, mark.id)
          const same =
            !!now?.keyframes &&
            now.keyframes.length === snapshot.keyframes!.length &&
            now.keyframes.every((k, j) => k.tSec === snapshot.keyframes![j].tSec)
          // Ended where it began (moved away and back, or every move refused): no step.
          if (same) useProject.getState().liveUpdateRoot(() => before)
          else useProject.getState().commitLive(before)
        }
      }
    )
  }

  const onRemove = (index: number): void => {
    if (!currentMark(layer.id, mark.id)) return
    const local = usePlayback.getState().time - layer.startSec
    useUi.getState().selectMarkKeyframe(null)
    useProject
      .getState()
      .updateGraphicsMarks(layer.id, (ms) => updateById(ms, mark.id, (m) => removeMarkKeyframe(m, index, local)))
  }

  return (
    <div
      data-testid={`mark-keyframes-${layer.id}`}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 h-3"
    >
      {shown.map(({ index, tSec }) => (
        <div
          key={index}
          data-testid={`mark-kf-diamond-${index}`}
          data-at-playhead={index === atIndex ? 'true' : undefined}
          data-picked={index === pickedIndex ? 'true' : undefined}
          className={`absolute bottom-[2px] -translate-x-1/2 rotate-45 cursor-ew-resize border ${
            index === pickedIndex
              ? 'border-amber-300 bg-amber-300 ring-2 ring-amber-500'
              : index === atIndex
                ? 'border-white bg-white ring-2 ring-sky-400'
                : 'border-white bg-sky-500'
          }`}
          style={{
            left: clampKeyframeX(keyframeX(tSec, pxPerSec), tileWidth),
            width: DIAMOND_PX,
            height: DIAMOND_PX,
            pointerEvents: 'all'
          }}
          title={`Keyframe at ${tSec.toFixed(2)}s — drag to move, double-click or Delete to remove`}
          onPointerDown={(e) => onDown(e, index)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onRemove(index)
          }}
        />
      ))}
    </div>
  )
}
