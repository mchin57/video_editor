/** Preview ▸ graphics: a graphics layer's marks (shapes + telestrator), drawn from the shared `markShapes`, and — on the layer being edited — the armed drawing tool, mark drags and point handles. */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { GraphicsContent, Layer } from '@shared/project'
import {
  angleMark,
  finishPolyline,
  fromCanvas,
  graphicsSvgTransform,
  markShapes,
  markVisibleAt,
  movedMark,
  newMark,
  polylineMark,
  toCanvas,
  type GraphicMark,
  type GraphicTool,
  type GraphicsTransform,
  type Pt
} from '@shared/graphics'
import {
  editPoseAt,
  isPosed,
  markPivot,
  markPoseAt,
  markPoseSvg,
  posePoint,
  posedMark,
  poseTransform,
  staticPose,
  withPivotAt,
  withPosedMarkPoint,
  type MarkPose
} from '@shared/markAnim'
import { framePoseAt, markArtSvg } from '@shared/markPresets'
import { layerTransformAt } from '@shared/layers'
import { newId } from '@shared/ids'
import { LOGICAL } from '@/lib/coords'
import { updateById } from '@/lib/arrays'
import { startDragWithUndo, startPointerDrag } from '@/lib/pointerDrag'
import { getActiveComp, useProject } from '@/state/projectStore'
import { mapGraphicsMarks } from '@/state/project/core'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { pct } from './frame'

/** Above every layer and the captions (300), under the frame's overlays (400). */
const EDIT_Z = 350
/** A mark's grab area: its stroke, fattened so a thin line is easy to catch. */
const hitWidth = (m: GraphicMark): number => Math.max(28, m.widthPx + 20)
/** Marks not on screen yet, shown faintly while their layer is being edited. */
const GHOST_OPACITY = 0.3

/** A mark's drawing — the same markup the export rasterises (`markArtSvg` / `markPoseSvg`), so the two draw identical pixels. */
function MarkArt({ mark, html, opacity = 1 }: { mark: GraphicMark; html: string; opacity?: number }): JSX.Element {
  return <g data-mark-id={mark.id} opacity={opacity} dangerouslySetInnerHTML={{ __html: html }} />
}

/** A mark as it is, un-posed and fully drawn (the half-drawn mark under the pen). */
const plainSvg = (mark: GraphicMark): string => markPoseSvg(mark, staticPose(mark), 1, 1)

/** An invisible fat copy of a mark's strokes (and fill) that takes the pointer, where the mark is drawn at `pose`. */
function MarkHit({
  mark,
  pose,
  onDown
}: {
  mark: GraphicMark
  pose: MarkPose
  onDown: (e: ReactPointerEvent) => void
}): JSX.Element {
  return (
    <g
      data-mark-hit={mark.id}
      onPointerDown={onDown}
      style={{ cursor: 'move' }}
      transform={isPosed(pose) ? poseTransform(pose, markPivot(mark)) : undefined}
    >
      {markShapes(posedMark(mark, pose), 1).map((s, i) =>
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
 * A graphics layer: every mark on screen at `time`, drawn through the shared
 * `markArtSvg` (the export draws the same markup). On the editable stage
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
  const len = layer.endSec - layer.startSec
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
            if (markVisibleAt(m, local))
              return <MarkArt key={m.id} mark={m} html={markArtSvg(m, local, len)} opacity={opacity} />
            return editing ? (
              <MarkArt key={m.id} mark={m} html={markPoseSvg(m, markPoseAt(m, local), 1, GHOST_OPACITY)} />
            ) : null
          })}
          {editable &&
            !selected &&
            content.marks.map((m) =>
              markVisibleAt(m, local) ? (
                <MarkHit
                  key={m.id}
                  mark={m}
                  pose={framePoseAt(m, local, len)}
                  onDown={(e) => startMarkMove(e, layer, m, t)}
                />
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
  // A keyframed mark is dragged by editing its offset at the playhead (its
  // dx/dy sit outermost in the pose, so no rotation correction is needed);
  // any other moves its points.
  const local = Math.max(0, usePlayback.getState().time - layer.startSec)
  const from = markPoseAt(m, local)
  const keyframed = !!m.keyframes && m.keyframes.length > 0
  startDragWithUndo((ev) => {
    const p = canvasPoint(svg, ev)
    const s = t.scale || 1
    const ddx = (p.x - start.x) / s
    const ddy = (p.y - start.y) / s
    const moved = keyframed ? editPoseAt(m, local, { dx: from.dx + ddx, dy: from.dy + ddy }) : movedMark(m, ddx, ddy)
    useProject.getState().liveUpdate((c) => mapGraphicsMarks(c, layer.id, (ms) => updateById(ms, m.id, () => moved)))
  })
}

/**
 * Editing the selected graphics layer, above everything else on the stage:
 *  - with a tool armed, a press anywhere draws that mark (drag = its size, a
 *    click = a default-sized one; an angle is three clicks: joint, then each
 *    limb; a connected line is a click per point, finished by a double-click
 *    or Enter), appearing at the playhead;
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
  /** A connected line's placed points so far (the ref is the always-current copy, since a
   *  double-click's two presses can land before a re-render). */
  const [polyPts, setPolyPts] = useState<Pt[]>([])
  const polyRef = useRef<Pt[]>([])
  const svgRef = useRef<SVGSVGElement>(null)

  const local = time - layer.startSec
  const len = layer.endSec - layer.startSec
  const atSec = Math.max(0, local)
  const commit = (mark: GraphicMark): void => {
    useProject.getState().updateGraphicsMarks(layer.id, (ms) => [...ms, mark])
    const ui = useUi.getState()
    ui.setGraphicsTool(null)
    ui.selectMark(mark.id)
  }

  /** Finish the connected line if it has 2+ distinct points; otherwise keep drawing. */
  const finishLine = (): void => {
    const pts = finishPolyline(polyRef.current)
    if (pts) commit(polylineMark(newId(), pts, atSec))
  }
  const finishRef = useRef(finishLine)
  useEffect(() => {
    finishRef.current = finishLine
  })

  useEffect(() => {
    if (tool !== 'polyline') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || polyRef.current.length === 0) return
      const el = e.target as HTMLElement | null
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      e.preventDefault()
      finishRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool])

  const onDrawDown = (e: ReactPointerEvent<SVGRectElement>): void => {
    if (!tool) return
    e.stopPropagation()
    e.preventDefault()
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const at = fromCanvas(t, canvasPoint(svg, e))
    if (tool === 'polyline') {
      polyRef.current = [...polyRef.current, at]
      setPolyPts(polyRef.current)
      return
    }
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
    // Grabbed where it is DRAWN: keyframes and presets both.
    const pose = framePoseAt(m, local, len)
    startDragWithUndo((ev) => {
      const next = withPosedMarkPoint(m, i, fromCanvas(t, canvasPoint(svg, ev)), local, pose)
      useProject.getState().liveUpdate((c) => mapGraphicsMarks(c, layer.id, (ms) => updateById(ms, m.id, () => next)))
    })
  }

  /** Drag the pivot: it lands on the mark-space point drawn under the pointer (measured through the pose as it was at the press). */
  const onPivotDown = (e: ReactPointerEvent, m: GraphicMark): void => {
    e.stopPropagation()
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    startDragWithUndo((ev) => {
      const next = withPivotAt(m, local, fromCanvas(t, canvasPoint(svg, ev)))
      useProject.getState().liveUpdate((c) => mapGraphicsMarks(c, layer.id, (ms) => updateById(ms, m.id, () => next)))
    })
  }

  const polyPreview =
    tool === 'polyline' && polyPts.length > 0 ? polylineMark('preview', hover ? [...polyPts, hover] : polyPts, 0) : null
  const selectedMark = !tool ? content.marks.find((m) => m.id === selectedMarkId) : undefined
  const selectedPose = selectedMark ? markPoseAt(selectedMark, local) : null
  const selectedDrawn = selectedMark ? framePoseAt(selectedMark, local, len) : null
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
            onDoubleClick={() => {
              if (tool === 'polyline') finishLine()
            }}
            onPointerMove={(e) => {
              const svg = e.currentTarget.ownerSVGElement
              if (!svg) return
              if (tool === 'angle' && anglePts.length > 0) setHover(fromCanvas(t, canvasPoint(svg, e)))
              if (tool === 'polyline' && polyPts.length > 0) setHover(fromCanvas(t, canvasPoint(svg, e)))
            }}
          />
        ) : null}
        <g transform={graphicsSvgTransform(t)} pointerEvents={tool ? 'none' : undefined}>
          {!tool &&
            content.marks.map((m) => (
              <MarkHit
                key={m.id}
                mark={m}
                pose={framePoseAt(m, local, len)}
                onDown={(e) => startMarkMove(e, layer, m, t)}
              />
            ))}
          {draft && <MarkArt mark={draft} html={plainSvg(draft)} />}
          {polyPreview && polyPreview.points.length >= 2 && (
            <MarkArt mark={polyPreview} html={plainSvg(polyPreview)} opacity={0.8} />
          )}
          {anglePreview && anglePts.length >= 2 && (
            <MarkArt mark={anglePreview} html={plainSvg(anglePreview)} opacity={0.8} />
          )}
          {anglePreview && anglePts.length === 1 && hover && (
            <MarkArt
              mark={anglePreview}
              html={plainSvg({ ...anglePreview, tool: 'line', points: [anglePts[0], hover] })}
              opacity={0.8}
            />
          )}
        </g>
      </svg>
      {/* Point handles: HTML so they keep one on-screen size at any zoom. */}
      {(selectedMark?.points ?? []).map((p, i) => {
        const c = toCanvas(t, posePoint(selectedDrawn!, markPivot(selectedMark!), p))
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
      {selectedMark && selectedPose && (
        <PivotHandle mark={selectedMark} pose={selectedPose} t={t} onDown={(e) => onPivotDown(e, selectedMark)} />
      )}
      {(tool === 'angle' ? anglePts : tool === 'polyline' ? polyPts : []).map((p, i) => {
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

/** The selected mark's pivot: a crosshair (distinct from the round point handles) where the pivot is drawn. */
function PivotHandle({
  mark,
  pose,
  t,
  onDown
}: {
  mark: GraphicMark
  pose: MarkPose
  t: GraphicsTransform
  onDown: (e: ReactPointerEvent) => void
}): JSX.Element {
  const pivot = markPivot(mark)
  const c = toCanvas(t, posePoint(pose, pivot, pivot))
  return (
    <div
      data-testid="mark-pivot"
      title="Pivot: rotation and size turn about this point. Drag to move it."
      onPointerDown={onDown}
      className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border border-amber-300 bg-black/20"
      style={{ left: pct(c.x, LOGICAL.width), top: pct(c.y, LOGICAL.height), zIndex: EDIT_Z + 2 }}
    >
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-amber-300" />
      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-amber-300" />
    </div>
  )
}
