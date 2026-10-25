/** Preview ▸ workout: a workout overlay's widgets, drawn from the shared `workoutOverlayShapes`, and — on the editable stage — each widget's box to grab and drag. */

import { type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { Layer, WorkoutContent } from '@shared/project'
import { LABEL_FONT_FAMILY, shapeSvg, type Pt } from '@shared/graphics'
import { WORKOUT_METRICS, workoutOverlayShapes, type WorkoutWidget } from '@shared/workoutOverlay'
import { LOGICAL } from '@/lib/coords'
import { updateById } from '@/lib/arrays'
import { startDragWithUndo } from '@/lib/pointerDrag'
import { getActiveComp, useProject } from '@/state/projectStore'
import { mapWorkoutWidgets } from '@/state/project/core'
import { useUi } from '@/state/ui'
import { useWorkoutSeries } from '@/hooks/useWorkout'

/** Pointer → canonical canvas px, from the SVG that covers the whole canvas. */
function canvasPoint(svg: Element, e: { clientX: number; clientY: number }): Pt {
  const r = svg.getBoundingClientRect()
  return { x: ((e.clientX - r.left) * LOGICAL.width) / r.width, y: ((e.clientY - r.top) * LOGICAL.height) / r.height }
}

/**
 * A workout overlay at `time`: the same SVG markup the export rasterises per
 * frame (`shapeSvg` of `workoutOverlayShapes`). On the editable stage every
 * widget's box takes the pointer — pressing selects the layer, dragging moves
 * that widget — and the selected layer outlines its widgets.
 */
export function StackWorkout({
  layer,
  content,
  z,
  time,
  selected,
  editable
}: {
  layer: Layer
  content: WorkoutContent
  z: number
  time: number
  selected: boolean
  editable: boolean
}): JSX.Element | null {
  const series = useWorkoutSeries(content.mediaId)
  const html = series
    ? workoutOverlayShapes(content, layer, series, time)
        .map((s) => shapeSvg(s, LABEL_FONT_FAMILY))
        .join('')
    : ''
  return (
    <svg
      data-testid="workout-layer"
      data-layer-id={layer.id}
      viewBox={`0 0 ${LOGICAL.width} ${LOGICAL.height}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: z
      }}
    >
      <g dangerouslySetInnerHTML={{ __html: html }} />
      {editable &&
        content.widgets.map((w) => {
          const b = WORKOUT_METRICS[w.metric].bounds(w)
          return (
            <rect
              key={w.id}
              data-testid={`workout-widget-${w.metric}`}
              data-widget-id={w.id}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              fill="transparent"
              stroke={selected ? 'rgba(56,189,248,0.8)' : 'none'}
              strokeWidth={3}
              strokeDasharray="14 10"
              pointerEvents="all"
              style={{ cursor: 'move' }}
              onPointerDown={(e) => startWidgetMove(e, layer, w)}
            />
          )
        })}
    </svg>
  )
}

/** Select the layer (its whole link group), then drag the widget. */
function startWidgetMove(e: ReactPointerEvent<SVGRectElement>, layer: Layer, w: WorkoutWidget): void {
  e.stopPropagation()
  e.preventDefault()
  const ui = useUi.getState()
  if (ui.selectedLayerId !== layer.id) ui.selectTile(getActiveComp(), { kind: 'layer', id: layer.id })
  const svg = e.currentTarget.ownerSVGElement
  if (!svg) return
  const start = canvasPoint(svg, e)
  startDragWithUndo((ev) => {
    const p = canvasPoint(svg, ev)
    const moved = { ...w, x: Math.round(w.x + p.x - start.x), y: Math.round(w.y + p.y - start.y) }
    useProject.getState().liveUpdate((c) => mapWorkoutWidgets(c, layer.id, (ws) => updateById(ws, w.id, () => moved)))
  })
}
