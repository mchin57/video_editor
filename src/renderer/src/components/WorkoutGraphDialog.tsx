import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { MediaAsset } from '@shared/media'
import { DEFAULT_DISTANCE_UNITS, sampleIndexAt, sportAt, type WorkoutSeries } from '@shared/workout'
import {
  axisMap,
  clampView,
  clockLabel,
  graphTicks,
  GRAPH_LINES,
  linePoints,
  panView,
  valueRange,
  zoomView,
  type GraphAxis,
  type GraphLineId,
  type GraphView
} from '@shared/workoutGraph'
import { distanceReading, formatSpeed, speedReading, workoutPlayedSec, workoutSpeed } from '@shared/workoutOverlay'
import { newId } from '@shared/ids'
import {
  deleteRange,
  rangeAt,
  rangeLocked,
  rangesChanged,
  setRangeSpeed,
  splitRangeAt,
  trimRangeEdge,
  type WorkoutTile
} from '@/lib/workoutGraph'
import { startPointerDrag } from '@/lib/pointerDrag'
import { useLatest } from '@/hooks/useLatest'
import { useWorkoutSeries } from '@/hooks/useWorkout'
import { NumberInput, btnCls, disabledCls, inputCls, toggleCls } from './ui'

/** Plot height (px) under the ranges band. */
const PLOT_H = 240
const BAND_H = 26
const AXIS_H = 18
const SVG_H = BAND_H + PLOT_H + AXIS_H

/**
 * Inspector ▸ Workout ▸ Graph… (docs/WORKOUT-OVERLAY.md "The graph window"):
 * the recording's power / elevation / speed / heart rate against time or
 * distance, with every tile showing it as a RANGE on top. Like Quick cut it
 * edits a working copy — trim a range's ends by its handles, split at the
 * cursor (S), delete a range (Del), set a range's speed — with its own undo,
 * and Save swaps the result onto the timeline as one undo step. The wheel
 * zooms (down to 1 s across the width), Shift+wheel or the bar below pans.
 * The editing rules are lib/workoutGraph.ts; the drawing math
 * shared/workoutGraph.ts. Keys pressed while it is open never reach the app's
 * own shortcuts.
 */
export function WorkoutGraphDialog({
  asset,
  tiles: initial,
  selectedId,
  onClose,
  onSave
}: {
  asset: MediaAsset
  /** The recording's tiles on the timeline being edited (`workoutTilesOf`). */
  tiles: WorkoutTile[]
  /** The tile the window was opened from: selected first. */
  selectedId: string
  onClose: () => void
  /** Apply the edit; a reason it couldn't (shown, the window stays open), or null. */
  onSave: (before: WorkoutTile[], after: WorkoutTile[]) => string | null
}): JSX.Element {
  const series = useWorkoutSeries(asset.id)
  // Until the editor is up (reading, or the read failed), Escape still closes
  // and no key reaches the editor behind.
  const close = useLatest(onClose)
  useEffect(() => {
    if (series) return
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [series, close])
  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/75 p-6"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        data-testid="workout-graph-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workout-graph-title"
        // Keys typed into a field go to the field (capture lets them through),
        // and stop here: the editor's shortcuts never see them.
        onKeyDown={(e) => e.stopPropagation()}
        className="flex max-h-full w-[min(1100px,96vw)] flex-col rounded-xl border border-white/10 bg-zinc-900 p-4 shadow-2xl"
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 id="workout-graph-title" className="truncate text-sm font-semibold text-zinc-100">
            Workout graph <span className="font-normal text-zinc-400">· {asset.fileName}</span>
          </h2>
          <span className="shrink-0 text-[11px] text-zinc-500">
            Wheel zoom · Shift+wheel pan · S split · Del delete range · ←/→ 1 s · Ctrl+Z undo
          </span>
        </div>
        {series ? (
          <GraphEditor
            asset={asset}
            series={series}
            initial={initial}
            selectedId={selectedId}
            onClose={onClose}
            onSave={onSave}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 p-6">
            <p data-testid="graph-status" className="text-center text-xs text-zinc-500">
              {series === null ? "Couldn't read this workout's recording." : 'Reading the workout…'}
            </p>
            <button data-testid="graph-cancel" onClick={onClose} className={`${btnCls} px-4`}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

function GraphEditor({
  asset,
  series,
  initial,
  selectedId,
  onClose,
  onSave
}: {
  asset: MediaAsset
  series: WorkoutSeries
  initial: WorkoutTile[]
  selectedId: string
  onClose: () => void
  onSave: (before: WorkoutTile[], after: WorkoutTile[]) => string | null
}): JSX.Element {
  const dur = asset.probe.durationSec
  const units = initial.find((t) => t.id === selectedId)?.content.units ?? DEFAULT_DISTANCE_UNITS
  const [hist, setHist] = useState<{ past: WorkoutTile[][]; now: WorkoutTile[]; future: WorkoutTile[][] }>(() => ({
    past: [],
    now: initial,
    future: []
  }))
  // A trim drag edits a draft; release commits it as ONE undo step.
  const [draft, setDraft] = useState<WorkoutTile[] | null>(null)
  const tiles = draft ?? hist.now
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      initial.findIndex((t) => t.id === selectedId)
    )
  )
  const [axis, setAxis] = useState<GraphAxis>('time')
  // Built once per series: a distance axis walks the whole recording.
  const maps = useMemo(() => ({ time: axisMap(series, 'time')!, distance: axisMap(series, 'distance') }), [series])
  const map = maps[axis] ?? maps.time
  const [view, setView] = useState<GraphView>(() => ({ x0: 0, x1: map.domain }))
  // The cursor starts at the start of the range the window was opened from.
  const [cursor, setCursor] = useState(
    () => (initial.find((t) => t.id === selectedId) ?? initial[0])?.content.inSec ?? 0
  )
  const [error, setError] = useState<string | null>(null)
  /** A speed being typed: its keystrokes are ONE undo step (cleared on focus). */
  const speedTyping = useRef(false)
  const [shown, setShown] = useState<Set<GraphLineId>>(
    () => new Set(GRAPH_LINES.filter((l) => l.values(series)).map((l) => l.id))
  )
  const plotRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(900)

  // The plot's width in px: bucketing and ticks follow the window's size.
  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(100, el.getBoundingClientRect().width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const commit = useCallback((next: WorkoutTile[] | null, select?: number) => {
    if (!next) return
    // An edit that changed nothing (a trim held at its limit) is no undo step.
    setHist((h) => (rangesChanged(h.now, next) ? { past: [...h.past, h.now], now: next, future: [] } : h))
    if (select !== undefined) setSelected(Math.max(0, Math.min(select, next.length - 1)))
  }, [])
  const undo = (): void =>
    setHist((h) =>
      h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] } : h
    )
  const redo = (): void =>
    setHist((h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h))
  // Undo can shrink the list under the selection (adjusted while rendering).
  if (selected > hist.now.length - 1) setSelected(hist.now.length - 1)

  const sel = tiles[selected]
  const locked = sel ? rangeLocked(sel) : null
  const underCursor = rangeAt(hist.now, cursor)
  const canSplit = underCursor >= 0 && !!splitRangeAt(hist.now, underCursor, cursor, () => '')
  const canDelete = !!deleteRange(hist.now, selected)
  const changed = rangesChanged(initial, hist.now)

  const split = (): void => {
    const i = rangeAt(hist.now, cursor)
    if (i >= 0) commit(splitRangeAt(hist.now, i, cursor, newId), i + 1)
  }
  const remove = (): void => commit(deleteRange(hist.now, selected), selected)
  const moveCursor = (sec: number): void => setCursor(Math.max(0, Math.min(dur, sec)))
  const save = (): void => {
    const why = changed ? onSave(initial, hist.now) : null
    if (why) setError(why)
    else onClose()
  }
  const typeSpeed = (v: number): void => {
    const next = setRangeSpeed(hist.now, selected, v)
    if (!rangesChanged(hist.now, next)) return
    if (speedTyping.current) setHist((h) => ({ ...h, now: next }))
    else {
      speedTyping.current = true
      commit(next, selected)
    }
  }

  // Switching the axis keeps the same stretch of the recording in view.
  const switchAxis = (next: GraphAxis): void => {
    const to = maps[next]
    if (!to || next === axis) return
    const a = map.toSec(view.x0)
    const b = map.toSec(view.x1)
    setView(clampView({ x0: to.toAxis(a), x1: to.toAxis(b) }, to.domain, to.minSpan))
    setAxis(next)
  }

  // Keys: capture phase, swallowed, so the app's shortcuts don't act on the edit behind.
  const keyActions = useLatest({ split, remove, undo, redo, moveCursor, cursor, onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Typing into a field (the speed) is the field's business, not a
      // shortcut: let it through to the field; the dialog stops it after.
      const t = e.target
      if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number') && e.key !== 'Escape') return
      e.stopPropagation()
      const a = keyActions.current
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') {
        e.preventDefault()
        a.onClose()
      } else if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) a.redo()
        else a.undo()
      } else if (mod && k === 'y') {
        e.preventDefault()
        a.redo()
      } else if (!mod && k === 's') {
        e.preventDefault()
        a.split()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        a.remove()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        a.moveCursor(a.cursor + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [keyActions]) // stable (useLatest)

  const span = view.x1 - view.x0
  const pxOf = (a: number): number => ((a - view.x0) / span) * width
  const axisAtX = (clientX: number): number => {
    const r = plotRef.current!.getBoundingClientRect()
    return view.x0 + ((clientX - r.left) / Math.max(1, r.width)) * span
  }

  // The wheel zooms about the pointer (Shift, or a sideways wheel, pans). A
  // native listener: React's wheel handlers are passive and can't stop the page scrolling.
  const wheel = useLatest({ map, width })
  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { map: m, width: w } = wheel.current
      const r = el.getBoundingClientRect()
      const f = (e.clientX - r.left) / Math.max(1, r.width)
      // From the view as it is NOW: several wheel events can land before a render.
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX
        setView((v) => panView(v, (d / w) * (v.x1 - v.x0), m.domain, m.minSpan))
      } else {
        setView((v) => zoomView(v, v.x0 + f * (v.x1 - v.x0), Math.exp(e.deltaY * 0.0015), m.domain, m.minSpan))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheel])

  // Press on the plot: put the cursor there (selecting the range under it) and scrub.
  const onPlotDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const place = (clientX: number): void => moveCursor(map.toSec(axisAtX(clientX)))
    const sec = map.toSec(axisAtX(e.clientX))
    const i = rangeAt(hist.now, sec)
    if (i >= 0) setSelected(i)
    place(e.clientX)
    startPointerDrag((ev) => place(ev.clientX))
  }

  // Drag a range's handle: trim that end (in ride time, whatever the axis).
  const onHandleDown = (e: ReactPointerEvent, index: number, edge: 'in' | 'out'): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelected(index)
    const base = hist.now
    let last = base
    startPointerDrag(
      (ev) => {
        last = trimRangeEdge(base, index, edge, map.toSec(axisAtX(ev.clientX)), dur)
        setDraft(last)
        const c = last[index].content
        moveCursor(edge === 'in' ? c.inSec : c.outSec)
      },
      () => {
        setDraft(null)
        commit(last)
      }
    )
  }

  // The scroll bar: drag the thumb to pan.
  const barRef = useRef<HTMLDivElement>(null)
  const onThumbDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const r = barRef.current!.getBoundingClientRect()
    const start = e.clientX
    const v0 = view
    startPointerDrag((ev) =>
      setView(panView(v0, ((ev.clientX - start) / r.width) * map.domain, map.domain, map.minSpan))
    )
  }

  const ticks = graphTicks(view, axis, width, units)
  const y = (v: number, lo: number, hi: number): number => BAND_H + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H
  const cursorPx = pxOf(map.toAxis(cursor))
  const readout = cursorReadout(series, cursor, units)

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          <button
            data-testid="graph-axis-time"
            className={toggleCls(axis === 'time')}
            onClick={() => switchAxis('time')}
          >
            Time
          </button>
          <button
            data-testid="graph-axis-distance"
            className={`${toggleCls(axis === 'distance')} ${disabledCls}`}
            disabled={!maps.distance}
            title={maps.distance ? undefined : 'This file has no distance.'}
            onClick={() => switchAxis('distance')}
          >
            Distance
          </button>
        </div>
        <div className="mx-1 h-4 w-px bg-white/10" />
        {GRAPH_LINES.map((l) => {
          const has = !!l.values(series)
          const on = shown.has(l.id)
          return (
            <label
              key={l.id}
              data-testid={`graph-toggle-${l.id}`}
              className={`flex items-center gap-1 text-xs ${has ? 'text-zinc-200' : 'text-zinc-600'}`}
              title={has ? undefined : `This file has no ${l.label.toLowerCase()}.`}
            >
              <input
                type="checkbox"
                checked={on && has}
                disabled={!has}
                onChange={(e) =>
                  setShown((s) => {
                    const next = new Set(s)
                    if (e.target.checked) next.add(l.id)
                    else next.delete(l.id)
                    return next
                  })
                }
              />
              <span className="inline-block h-2 w-3 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </label>
          )
        })}
        <div className="flex-1" />
        <button
          data-testid="graph-fit"
          onClick={() => setView({ x0: 0, x1: map.domain })}
          className={btnCls}
          title="Show the whole recording"
        >
          Fit
        </button>
      </div>

      <p data-testid="graph-readout" className="mb-1 font-mono text-[11px] text-zinc-300">
        {readout}
      </p>

      <svg
        ref={plotRef}
        data-testid="graph-plot"
        data-axis={axis}
        data-x0={view.x0}
        data-x1={view.x1}
        width="100%"
        height={SVG_H}
        onPointerDown={onPlotDown}
        className="cursor-text select-none rounded bg-black/40"
      >
        {/* Where the timer was stopped, shaded; laps as dashed lines. */}
        {series.pauses.map((p, i) => {
          const a = pxOf(map.toAxis(p.startSec))
          const b = pxOf(map.toAxis(p.endSec))
          return b > 0 && a < width ? (
            <rect
              data-testid="graph-pause"
              key={`p${i}`}
              x={a}
              y={BAND_H}
              width={Math.max(1, b - a)}
              height={PLOT_H}
              fill="rgba(255,255,255,0.06)"
            />
          ) : null
        })}
        {series.laps.slice(1).map((l, i) => {
          const x = pxOf(map.toAxis(l.startSec))
          return x >= 0 && x <= width ? (
            <line
              key={`l${i}`}
              data-testid="graph-lap"
              x1={x}
              x2={x}
              y1={BAND_H}
              y2={BAND_H + PLOT_H}
              stroke="rgba(255,255,255,0.25)"
              strokeDasharray="4 4"
            />
          ) : null
        })}

        {/* Each tile's range, tinted down the plot. */}
        {tiles.map((t, i) => {
          const a = pxOf(map.toAxis(t.content.inSec))
          const b = pxOf(map.toAxis(t.content.outSec))
          return (
            <rect
              key={`tint${t.id}`}
              x={a}
              y={BAND_H}
              width={Math.max(1, b - a)}
              height={PLOT_H}
              fill={i === selected ? 'rgba(244,63,94,0.12)' : 'rgba(244,63,94,0.06)'}
            />
          )
        })}

        {GRAPH_LINES.filter((l) => shown.has(l.id)).map((l) => {
          const pts = linePoints(l.values(series), map, view, width)
          if (pts.length < 2) return null
          const { lo, hi } = valueRange(pts)
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${y(p.value, lo, hi).toFixed(1)}`).join(' ')
          return (
            <path key={l.id} data-testid={`graph-line-${l.id}`} d={d} fill="none" stroke={l.color} strokeWidth={1.5} />
          )
        })}

        {/* The ranges band: one block per tile, handles at its ends. */}
        {tiles.map((t, i) => {
          const a = pxOf(map.toAxis(t.content.inSec))
          const b = pxOf(map.toAxis(t.content.outSec))
          const lock = rangeLocked(t)
          return (
            <g
              key={t.id}
              data-testid={`graph-range-${i}`}
              data-in={t.content.inSec}
              data-out={t.content.outSec}
              data-selected={i === selected}
            >
              <rect
                x={a}
                y={2}
                width={Math.max(2, b - a)}
                height={BAND_H - 4}
                rx={3}
                fill={i === selected ? 'rgba(244,63,94,0.55)' : 'rgba(244,63,94,0.3)'}
                stroke={i === selected ? '#fda4af' : 'rgba(244,63,94,0.6)'}
                strokeDasharray={lock ? '4 3' : undefined}
              />
              <text x={a + 10} y={BAND_H / 2 + 4} fill="#ffe4e6" fontSize={10} pointerEvents="none">
                {lock ? '🔗 ' : ''}
                {formatSpeed(workoutSpeed(t.content))}× · {workoutPlayedSec(t.content).toFixed(1)}s
              </text>
              {/* Handles sit INSIDE their range, so two ranges that meet (a
                  split) each keep a handle of their own at the seam. */}
              {!lock && (
                <>
                  <rect
                    data-testid={`graph-handle-in-${i}`}
                    x={a}
                    y={0}
                    width={8}
                    height={BAND_H}
                    fill="rgba(255,228,230,0.7)"
                    style={{ cursor: 'ew-resize' }}
                    onPointerDown={(e) => onHandleDown(e, i, 'in')}
                  />
                  <rect
                    data-testid={`graph-handle-out-${i}`}
                    x={b - 8}
                    y={0}
                    width={8}
                    height={BAND_H}
                    fill="rgba(255,228,230,0.7)"
                    style={{ cursor: 'ew-resize' }}
                    onPointerDown={(e) => onHandleDown(e, i, 'out')}
                  />
                </>
              )}
            </g>
          )
        })}

        {ticks.map((t) => (
          <text
            key={t.at}
            x={pxOf(t.at)}
            y={SVG_H - 5}
            fill="#71717a"
            fontSize={10}
            textAnchor={pxOf(t.at) < 24 ? 'start' : pxOf(t.at) > width - 24 ? 'end' : 'middle'}
            pointerEvents="none"
          >
            {t.label}
          </text>
        ))}
        <line
          data-testid="graph-cursor"
          data-sec={cursor}
          x1={cursorPx}
          x2={cursorPx}
          y1={0}
          y2={BAND_H + PLOT_H}
          stroke="#fb7185"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      </svg>

      {/* Scroll bar: the whole recording, the shown part as the thumb. */}
      <div ref={barRef} data-testid="graph-scrollbar" className="relative mt-1 h-2 rounded bg-white/5">
        <div
          data-testid="graph-thumb"
          onPointerDown={onThumbDown}
          className="absolute inset-y-0 cursor-grab rounded bg-white/25 hover:bg-white/40"
          style={{ left: `${(view.x0 / map.domain) * 100}%`, width: `${Math.max(1, (span / map.domain) * 100)}%` }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span data-testid="graph-selected" className="text-[11px] text-zinc-300">
          {sel
            ? `Range ${selected + 1} of ${tiles.length} · ${clockLabel(sel.content.inSec)}–${clockLabel(sel.content.outSec)} of the workout`
            : ''}
        </span>
        {sel && !locked && (
          <label
            data-testid="graph-speed"
            onFocus={() => (speedTyping.current = false)}
            className="flex items-center gap-1 text-[11px] text-zinc-400"
          >
            Speed ×
            <NumberInput
              step="1"
              min={0.25}
              value={workoutSpeed(sel.content)}
              format={(v) => formatSpeed(v)}
              onCommit={typeSpeed}
              className={`${inputCls} w-20`}
            />
          </label>
        )}
        {locked && (
          <span data-testid="graph-locked" className="text-[11px] text-amber-300/90">
            {locked}
          </span>
        )}
        <div className="flex-1" />
        <button
          data-testid="graph-split"
          disabled={!canSplit}
          onClick={split}
          title={
            canSplit
              ? 'Split the range under the cursor (S)'
              : 'Put the cursor inside an unlinked range, away from its ends'
          }
          className={`${btnCls} ${disabledCls}`}
        >
          ✂ Split
        </button>
        <button
          data-testid="graph-delete"
          disabled={!canDelete}
          onClick={remove}
          title={locked ?? (tiles.length <= 1 ? 'There must be at least one range' : 'Delete the selected range (Del)')}
          className={`${btnCls} ${disabledCls}`}
        >
          Delete range
        </button>
        <button
          disabled={!hist.past.length}
          onClick={undo}
          title="Undo (Ctrl+Z)"
          className={`${btnCls} ${disabledCls}`}
        >
          ↶
        </button>
        <button
          disabled={!hist.future.length}
          onClick={redo}
          title="Redo (Ctrl+Shift+Z)"
          className={`${btnCls} ${disabledCls}`}
        >
          ↷
        </button>
      </div>

      <p className="mt-2 text-[11px] text-zinc-500">
        Each range is an overlay tile on the timeline. Deleting one leaves a gap there; Save applies everything as one
        undo step.
      </p>

      {error && (
        <p
          data-testid="graph-error"
          role="alert"
          className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300"
        >
          {error}
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button data-testid="graph-cancel" onClick={onClose} className={`${btnCls} px-4`}>
          Cancel
        </button>
        <button
          data-testid="graph-save"
          onClick={save}
          disabled={!changed}
          title={changed ? undefined : 'Nothing to save yet'}
          className="rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500/90"
        >
          Save
        </button>
      </div>
    </>
  )
}

/** The values at the cursor: "1:02:03 · 12.40 MI · 245 W · 152 BPM · 21.3 MPH · 312 FT". */
function cursorReadout(s: WorkoutSeries, sec: number, units: 'imperial' | 'metric'): string {
  const i = Math.max(0, sampleIndexAt(s, sec))
  const parts = [clockLabel(sec)]
  const d = s.distanceM?.[i] ?? null
  if (s.distanceM) {
    const r = distanceReading(d, units)
    parts.push(`${r.value} ${r.unit}`)
  }
  if (s.powerW) parts.push(`${s.powerW[i] ?? '--'} W`)
  if (s.heartRate) parts.push(`${s.heartRate[i] ?? '--'} BPM`)
  if (s.speedMps) {
    const r = speedReading(s.speedMps[i] ?? null, sportAt(s, sec), units)
    parts.push(`${r.value} ${r.unit}`)
  }
  const alt = s.altitudeM?.[i]
  if (alt !== undefined && alt !== null) {
    parts.push(units === 'imperial' ? `${Math.round(alt * 3.28084)} FT` : `${Math.round(alt)} M`)
  }
  return parts.join(' · ')
}
