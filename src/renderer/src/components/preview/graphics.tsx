/** Preview ▸ graphics: a graphics layer's marks (shapes + telestrator), drawn from the shared `markShapes`, and — on the layer being edited — the armed drawing tool, mark drags and point handles. */

import { useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { GraphicsContent, Layer } from '@shared/project'
import {
  angleMark,
  fromCanvas,
  graphicsSvgTransform,
  LABEL_FONT_FAMILY,
  markShapes,
  markStateAt,
  movedMark,
  newMark,
  shapeSvg,
  toCanvas,
  withMarkPoint,
  type GraphicMark,
  type GraphicTool,
  type GraphicsTransform,
  type Pt
} from '@shared/graphics'
import { layerTransformAt } from '@shared/layers'
import { newId } from '@shared/ids'
import { LOGICAL } from '@/lib/coords'
import { updateById } from '@/lib/arrays'
import { startDragWithUndo, startPointerDrag } from '@/lib/pointerDrag'
import { getActiveComp, useProject } from '@/state/projectStore'
import { mapGraphicsMarks } from '@/state/project/core'
import { useUi } from '@/state/ui'
import { pct } from './frame'

/** Above every layer and the captions (300), under the frame's overlays (400). */
const EDIT_Z = 350
/** A mark's grab area: its stroke, fattened so a thin line is easy to catch. */
const hitWidth = (m: GraphicMark): number => Math.max(28, m.widthPx + 20)
/** Marks not on screen yet, shown faintly while their layer is being edited. */
const GHOST_OPACITY = 0.3

/** The same SVG markup the export rasterises (`shapeSvg`), so the two draw identical pixels. */
function MarkArt({ mark, progress, opacity }: { mark: GraphicMark; progress: number; opacity: number }): JSX.Element {
  const html = markShapes(mark, progress)
    .map((s) => shapeSvg(s, LABEL_FONT_FAMILY))
    .join('')
  return <g data-mark-id={mark.id} opacity={opacity} dangerouslySetInnerHTML={{ __html: html }} />
}

/** An invisible fat copy of a mark's strokes (and fill) that takes the pointer. */
function MarkHit({ mark, onDown }: { mark: GraphicMark; onDown: (e: ReactPointerEvent) => void }): JSX.Element {
  return (
    <g data-mark-hit={mark.id} onPointerDown={onDown} style={{ cursor: 'move' }}>
      {markShapes(mark, 1).map((s, i) =>
        s.kind === 'path' ? (
          <path
            key={i}
            d={s.d}
            fill={s.fill ? 'transparent' : 'none'}
            stroke="transparent"
            strokeWidth={hitWidth(mark)}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents={s.fill ? 'all' : 'stroke'}
          />
        ) : null
      )}
    </g>
  )
}

/** Pointer → canonical canvas px, from the SVG that covers the whole canvas. */
function canvasPoint(svg: Element, e: { clientX: number; clientY: number }): Pt {
  const r = svg.getBoundingClientRect()
  return { x: ((e.clientX - r.left) * LOGICAL.width) / r.width, y: ((e.clientY - r.top) * LOGICAL.height) / r.height }
}

/** The SVG covering the canonical canvas that marks are drawn into. */
const canvasSvgStyle = (zIndex: number): CSSProperties => ({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  overflow: 'visible',
  pointerEvents: 'none',
  zIndex
})

/**
 * A graphics layer: every mark on screen at `time`, revealed through the shared
 * `markStateAt` (the export samples the same function). On the editable stage
 * an unselected layer's marks are clickable (selecting the layer and the mark);
 * the selected layer gets `GraphicsEditor` on top.
 */
export function StackGraphics({
  layer,
  rawLayer,
  content,
  z,
  time,
  selected,
  editable
}: {
  /** The layer with its keyframed transform applied at `time`. */
  layer: Layer
  rawLayer: Layer
  content: GraphicsContent
  z: number
  time: number
  selected: boolean
  editable: boolean
}): JSX.Element {
  const t: GraphicsTransform = { x: layer.x, y: layer.y, scale: layer.scale }
  const local = time - layer.startSec
  const editing = editable && selected
  const opacity = layerTransformAt(rawLayer, time).opacity
  const tool = useUi((s) => s.graphicsTool)
  return (
    <>
      <svg
        data-testid="graphics-layer"
        data-layer-id={layer.id}
        viewBox={`0 0 ${LOGICAL.width} ${LOGICAL.height}`}
        preserveAspectRatio="none"
        style={canvasSvgStyle(z)}
      >
        <g transform={graphicsSvgTransform(t)}>
          {/* The layer's keyframed opacity applies per MARK, like the export,
              which composites each mark as its own overlay. */}
          {content.marks.map((m) => {
            const st = markStateAt(m, local)
            if (st) return <MarkArt key={m.id} mark={m} progress={st.progress} opacity={st.opacity * opacity} />
            return editing ? <MarkArt key={m.id} mark={m} progress={1} opacity={GHOST_OPACITY} /> : null
          })}
          {editable &&
            !selected &&
            content.marks.map((m) =>
              markStateAt(m, local) ? (
                <MarkHit key={m.id} mark={m} onDown={(e) => startMarkMove(e, layer, m, t)} />
              ) : null
            )}
        </g>
      </svg>
      {/* Keyed by the tool: disarming (Escape, another tool, a selection
          change) remounts it, dropping whatever was half-drawn. */}
      {editing && <GraphicsEditor key={tool ?? ''} tool={tool} layer={layer} content={content} t={t} time={time} />}
    </>
  )
}

/** Select the layer (its whole link group) and this mark, then drag the mark. */
function startMarkMove(e: ReactPointerEvent, layer: Layer, m: GraphicMark, t: GraphicsTransform): void {
  e.stopPropagation()
  e.preventDefault()
  const ui = useUi.getState()
  if (ui.selectedLayerId !== layer.id) ui.selectTile(getActiveComp(), { kind: 'layer', id: layer.id })
  useUi.getState().selectMark(m.id)
  const svg = (e.currentTarget as SVGElement).ownerSVGElement
  if (!svg) return
  const start = canvasPoint(svg, e)
  startDragWithUndo((ev) => {
    const p = canvasPoint(svg, ev)
    const s = t.scale || 1
    const moved = movedMark(m, (p.x - start.x) / s, (p.y - start.y) / s)
    useProject.getState().liveUpdate((c) => mapGraphicsMarks(c, layer.id, (ms) => updateById(ms, m.id, () => moved)))
  })
}

/**
 * Editing the selected graphics layer, above everything else on the stage:
 *  - with a tool armed, a press anywhere draws that mark (drag = its size, a
 *    click = a default-sized one; an angle is three clicks: joint, then each
 *    limb), appearing at the playhead;
 *  - otherwise every mark can be grabbed and dragged, and the selected one
 *    shows its points as handles.
 */
function GraphicsEditor({
  tool,
  layer,
  content,
  t,
  time
}: {
  tool: GraphicTool | null
  layer: Layer
  content: GraphicsContent
  t: GraphicsTransform
  time: number
}): JSX.Element {
  const selectedMarkId = useUi((s) => s.selectedMarkId)
  /** The mark being drawn (drag tools), shown live until release. */
  const [draft, setDraft] = useState<GraphicMark | null>(null)
  /** An angle's placed points so far, plus where the pointer is. */
  const [anglePts, setAnglePts] = useState<Pt[]>([])
  const [hover, setHover] = useState<Pt | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const atSec = Math.max(0, time - layer.startSec)
  const commit = (mark: GraphicMark): void => {
    useProject.getState().updateGraphicsMarks(layer.id, (ms) => [...ms, mark])
    const ui = useUi.getState()
    ui.setGraphicsTool(null)
    ui.selectMark(mark.id)
  }

  const onDrawDown = (e: ReactPointerEvent<SVGRectElement>): void => {
    if (!tool) return
    e.stopPropagation()
    e.preventDefault()
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const at = fromCanvas(t, canvasPoint(svg, e))
    if (tool === 'angle') {
      const pts = [...anglePts, at]
      if (pts.length < 3) setAnglePts(pts)
      else commit(angleMark(newId(), pts[0], pts[1], pts[2], atSec))
      return
    }
    const id = newId()
    let last = at
    startPointerDrag(
      (ev) => {
        last = fromCanvas(t, canvasPoint(svg, ev))
        setDraft(newMark(tool, id, at, last, atSec))
      },
      () => {
        setDraft(null)
        // Disarmed mid-drag (Escape, another tool): the draw is cancelled.
        if (useUi.getState().graphicsTool !== tool) return
        commit(newMark(tool, id, at, last, atSec))
      }
    )
  }

  const onPointDown = (e: ReactPointerEvent, m: GraphicMark, i: number): void => {
    e.stopPropagation()
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    startDragWithUndo((ev) => {
      const next = withMarkPoint(m, i, fromCanvas(t, canvasPoint(svg, ev)))
      useProject.getState().liveUpdate((c) => mapGraphicsMarks(c, layer.id, (ms) => updateById(ms, m.id, () => next)))
    })
  }

  const selectedMark = !tool ? content.marks.find((m) => m.id === selectedMarkId) : undefined
  const anglePreview =
    tool === 'angle' && anglePts.length > 0
      ? angleMark('preview', anglePts[0], anglePts[1] ?? hover ?? anglePts[0], anglePts[2] ?? hover ?? anglePts[0], 0)
      : null

  return (
    <>
      <svg
        ref={svgRef}
        data-graphics-editor=""
        viewBox={`0 0 ${LOGICAL.width} ${LOGICAL.height}`}
        preserveAspectRatio="none"
        style={canvasSvgStyle(EDIT_Z)}
      >
        {tool ? (
          // The whole canvas (and past it, so a mark can start off-frame) takes the press.
          <rect
            data-testid="graphics-draw-surface"
            x={-LOGICAL.width}
            y={-LOGICAL.height}
            width={LOGICAL.width * 3}
            height={LOGICAL.height * 3}
            fill="transparent"
            pointerEvents="all"
            style={{ cursor: 'crosshair' }}
            onPointerDown={onDrawDown}
            onPointerMove={(e) => {
              const svg = e.currentTarget.ownerSVGElement
              if (tool === 'angle' && anglePts.length > 0 && svg) setHover(fromCanvas(t, canvasPoint(svg, e)))
            }}
          />
        ) : null}
        <g transform={graphicsSvgTransform(t)} pointerEvents={tool ? 'none' : undefined}>
          {!tool &&
            content.marks.map((m) => <MarkHit key={m.id} mark={m} onDown={(e) => startMarkMove(e, layer, m, t)} />)}
          {draft && <MarkArt mark={draft} progress={1} opacity={1} />}
          {anglePreview && anglePts.length >= 2 && <MarkArt mark={anglePreview} progress={1} opacity={0.8} />}
          {anglePreview && anglePts.length === 1 && hover && (
            <MarkArt
              mark={{ ...anglePreview, tool: 'line', points: [anglePts[0], hover] }}
              progress={1}
              opacity={0.8}
            />
          )}
        </g>
      </svg>
      {/* Point handles: HTML so they keep one on-screen size at any zoom. */}
      {(selectedMark?.points ?? []).map((p, i) => {
        const c = toCanvas(t, p)
        return (
          <div
            key={i}
            data-testid={`mark-point-${i}`}
            onPointerDown={(e) => onPointDown(e, selectedMark!, i)}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-sky-500 shadow"
            style={{ left: pct(c.x, LOGICAL.width), top: pct(c.y, LOGICAL.height), zIndex: EDIT_Z + 1 }}
          />
        )
      })}
      {tool === 'angle' &&
        anglePts.map((p, i) => {
          const c = toCanvas(t, p)
          return (
            <div
              key={i}
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-300"
              style={{ left: pct(c.x, LOGICAL.width), top: pct(c.y, LOGICAL.height), zIndex: EDIT_Z + 1 }}
            />
          )
        })}
    </>
  )
}
