/**
 * Timeline ▸ the volume line ("rubber band") on a SELECTED audio tile.
 *
 * Drawn over the tile's waveform; only the line itself and its points take the
 * pointer, so the rest of the tile still moves and trims the clip (and an
 * unselected tile shows no line at all). Click the line to add a point there —
 * at the line's own level, so nothing changes until you drag — and keep
 * dragging to place it; drag a point (up/down = level, sideways = time, never
 * past a neighbour or out of the clip); double-click it to remove it, or click
 * it and press Delete. Every gesture is ONE undo step (`liveUpdate` while
 * dragging, `commitLive` on release). The values are `shared/audioEnvelope.ts`
 * — the preview and the export both play exactly this line.
 */

import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioClip, Project, VolumeKeyframe } from '@shared/project'
import {
  addVolumeKeyframe,
  isSilenceDb,
  moveVolumeKeyframe,
  removeVolumeKeyframe,
  sortedVolumeKeyframes,
  volumeLineDbAt,
  withVolumeKeyframes
} from '@shared/audioEnvelope'
import { updateById } from '@/lib/arrays'
import { startPointerDrag } from '@/lib/pointerDrag'
import { dbToFrac, fracToDb, pickedVolumePointIndex, sourceToX, volumeLinePolyline, xToSource } from '@/lib/volumeLine'
import { getActiveComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { CLICK_SLOP } from './constants'

/** Live-edit one clip's line in the active comp (no history — the gesture's
 *  `commitLive` records it). */
function liveSetLine(clipId: string, points: VolumeKeyframe[]): void {
  useProject.getState().liveUpdate((c) => ({
    ...c,
    audioClips: updateById(c.audioClips, clipId, (a) => withVolumeKeyframes(a, points))
  }))
}

export function VolumeLineOverlay({
  clip,
  outSec,
  pxPerSec,
  height
}: {
  clip: AudioClip
  /** The clip's effective source out-point. */
  outSec: number
  pxPerSec: number
  /** The tile's height (px). */
  height: number
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const picked = useUi((s) => s.selectedVolumePoint)
  const points = sortedVolumeKeyframes(clip)
  const width = Math.max(12, (outSec - clip.inSec) * pxPerSec)
  const pickedIndex = picked && picked.clipId === clip.id ? pickedVolumePointIndex({ audioClips: [clip] }, picked) : -1

  /** Drag point `index` of `start` (the line as the gesture began, maybe with
   *  a point just added) from the press `e`; `before` is the undo snapshot. */
  const dragPoint = (e: ReactPointerEvent, before: Project, start: VolumeKeyframe[], index: number): void => {
    const p0 = start[index]
    const y0 = dbToFrac(p0.db) * height
    const x0 = e.clientX
    const yStart = e.clientY
    useUi.getState().selectVolumePoint({ clipId: clip.id, index, sourceSec: p0.sourceSec })
    let dragged = false
    startPointerDrag(
      (ev) => {
        const dx = ev.clientX - x0
        const dy = ev.clientY - yStart
        if (!dragged && Math.abs(dx) <= CLICK_SLOP && Math.abs(dy) <= CLICK_SLOP) return
        dragged = true
        const next = moveVolumeKeyframe(
          start,
          index,
          { sourceSec: p0.sourceSec + dx / pxPerSec, db: fracToDb((y0 + dy) / height) },
          { min: clip.inSec, max: outSec }
        )
        liveSetLine(clip.id, next)
        useUi.getState().selectVolumePoint({ clipId: clip.id, index, sourceSec: next[index].sourceSec })
      },
      () => useProject.getState().commitLive(before)
    )
  }

  const begin = (e: ReactPointerEvent): Project | null => {
    // The tile underneath must not start a move, nor the track a scrub.
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return null
    return useProject.getState().project
  }

  const onLineDown = (e: ReactPointerEvent): void => {
    const before = begin(e)
    const svg = svgRef.current
    if (!before || !svg) return
    const at = xToSource(clip, e.clientX - svg.getBoundingClientRect().left, pxPerSec)
    // A new point sits ON the line, so adding one never changes the sound.
    const { points: added, index } = addVolumeKeyframe(points, { sourceSec: at, db: volumeLineDbAt(points, at) })
    liveSetLine(clip.id, added)
    dragPoint(e, before, added, index)
  }

  const onPointDown = (e: ReactPointerEvent, index: number): void => {
    const before = begin(e)
    if (before) dragPoint(e, before, points, index)
  }

  const removePoint = (index: number): void => {
    const now = getActiveComp()?.audioClips.find((a) => a.id === clip.id)
    if (!now) return
    useProject.getState().setVolumeKeyframes(clip.id, removeVolumeKeyframe(sortedVolumeKeyframes(now), index))
    useUi.getState().selectVolumePoint(null)
  }

  const line = volumeLinePolyline(clip, outSec, pxPerSec, width, height)
  return (
    <svg
      ref={svgRef}
      data-testid={`volume-line-${clip.id}`}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={width}
      height={height}
    >
      {/* The visible line, then a wide invisible copy that takes the click. */}
      <polyline points={line} fill="none" stroke="rgb(253 230 138)" strokeWidth={1.5} />
      <polyline
        data-testid={`volume-line-hit-${clip.id}`}
        points={line}
        fill="none"
        stroke="transparent"
        strokeWidth={8}
        className="cursor-copy"
        style={{ pointerEvents: 'stroke' }}
        onPointerDown={onLineDown}
      >
        <title>Volume line: click to add a point, then drag it</title>
      </polyline>
      {points.map((k, i) => (
        <circle
          key={`${i}-${k.sourceSec}`}
          data-testid={`volume-point-${clip.id}-${i}`}
          data-picked={i === pickedIndex ? 'true' : undefined}
          cx={sourceToX(clip, k.sourceSec, pxPerSec)}
          cy={dbToFrac(k.db) * height}
          r={i === pickedIndex ? 4 : 3.5}
          fill={i === pickedIndex ? 'rgb(255 255 255)' : 'rgb(253 230 138)'}
          stroke="rgb(120 53 15)"
          strokeWidth={1}
          className="cursor-move"
          style={{ pointerEvents: 'all' }}
          onPointerDown={(e) => onPointDown(e, i)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            removePoint(i)
          }}
        >
          <title>{`${isSilenceDb(k.db) ? 'Silence' : `${k.db > 0 ? '+' : ''}${k.db.toFixed(1)} dB`} — drag to move, double-click or Delete to remove`}</title>
        </circle>
      ))}
    </svg>
  )
}
