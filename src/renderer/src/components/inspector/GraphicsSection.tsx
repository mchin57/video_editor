/** Inspector ▸ a GRAPHICS layer: the drawing tools, its list of marks, and the selected mark's style and timing. */

import { type JSX } from 'react'
import type { GraphicsContent, Layer } from '@shared/project'
import {
  GRAPHIC_TOOLS,
  MARK_REVEALS,
  markTitle,
  TOOL_INFO,
  withLockAspect,
  type GraphicMark,
  type MarkReveal
} from '@shared/graphics'
import { updateById } from '@/lib/arrays'
import { getAlpha, hex6, withAlpha } from '@/lib/color'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { CollapsibleSection } from '../CollapsibleSection'
import { Check, Field, NumberInput, Slider, colorCls, inputCls, subtleBtnCls, toggleCls } from '../ui'

/** A fill switched on starts as the stroke colour, see-through (alpha byte). */
const DEFAULT_FILL_ALPHA = 102
/** A fill's opacity as a whole percent. */
const fillPct = (fill: string): number => Math.round((getAlpha(fill) / 255) * 100)

export function GraphicsSection({ layer, content }: { layer: Layer; content: GraphicsContent }): JSX.Element {
  const tool = useUi((s) => s.graphicsTool)
  const selectedMarkId = useUi((s) => s.selectedMarkId)
  const update = useProject((s) => s.updateGraphicsMarks)
  const marks = content.marks
  const selected = marks.find((m) => m.id === selectedMarkId) ?? null
  const dur = Math.max(0, layer.endSec - layer.startSec)

  const patch = (id: string, fn: (m: GraphicMark) => GraphicMark): void =>
    update(layer.id, (ms) => updateById(ms, id, fn))
  const move = (i: number, dir: -1 | 1): void =>
    update(layer.id, (ms) => {
      const j = i + dir
      if (j < 0 || j >= ms.length) return ms
      const next = ms.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const remove = (id: string): void => {
    update(layer.id, (ms) => ms.filter((m) => m.id !== id))
    if (useUi.getState().selectedMarkId === id) useUi.getState().selectMark(null)
  }

  return (
    <CollapsibleSection id="graphics" title="Graphics">
      <div className="mb-1 flex flex-wrap gap-1">
        {GRAPHIC_TOOLS.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`graphics-tool-${t}`}
            aria-pressed={tool === t}
            title={TOOL_INFO[t].hint}
            onClick={() => {
              // The tile only draws (and takes the pen) while the playhead is
              // inside it: arming from outside brings the playhead to its start.
              const pb = usePlayback.getState()
              if (tool !== t && (pb.time < layer.startSec || pb.time >= layer.endSec)) pb.setTime(layer.startSec)
              useUi.getState().setGraphicsTool(tool === t ? null : t)
            }}
            className={toggleCls(tool === t)}
          >
            {TOOL_INFO[t].label}
          </button>
        ))}
      </div>
      <p className="mb-2 text-[10px] leading-snug text-zinc-500" data-testid="graphics-hint">
        {tool
          ? `${TOOL_INFO[tool].hint} on the preview. Esc to cancel.`
          : 'Pick a tool, then draw on the preview. A new mark appears at the playhead.'}
      </p>

      {marks.length > 0 && (
        <ul className="mb-2 space-y-0.5" data-testid="graphics-marks">
          {marks.map((m, i) => (
            <li
              key={m.id}
              className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs ${
                m.id === selectedMarkId ? 'bg-sky-500/20 text-zinc-100' : 'text-zinc-300 hover:bg-white/5'
              }`}
            >
              <button
                type="button"
                data-testid={`mark-row-${i}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => useUi.getState().selectMark(m.id)}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                <span className="truncate">{markTitle(m)}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-500">{m.atSec.toFixed(1)}s</span>
              </button>
              <button
                type="button"
                title="Send backward (under the marks after it)"
                onClick={() => move(i, -1)}
                disabled={i === 0}
              >
                ↑
              </button>
              <button
                type="button"
                title="Bring forward (over the marks before it)"
                onClick={() => move(i, 1)}
                disabled={i === marks.length - 1}
              >
                ↓
              </button>
              <button
                type="button"
                title="Delete this mark"
                data-testid={`mark-delete-${i}`}
                onClick={() => remove(m.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <MarkFields
          mark={selected}
          maxAtSec={dur}
          onPatch={(fn) => patch(selected.id, fn)}
          playheadAtSec={() => usePlayback.getState().time - layer.startSec}
        />
      )}
    </CollapsibleSection>
  )
}

/** The selected mark's look (colour, stroke, fill, corners) and when/how it comes on. */
function MarkFields({
  mark,
  maxAtSec,
  onPatch,
  playheadAtSec
}: {
  mark: GraphicMark
  maxAtSec: number
  onPatch: (fn: (m: GraphicMark) => GraphicMark) => void
  playheadAtSec: () => number
}): JSX.Element {
  const box = mark.tool === 'rect' || mark.tool === 'ellipse'
  const clampAt = (v: number): number => Math.min(Math.max(0, maxAtSec - 0.05), Math.max(0, v))
  return (
    <div data-testid="mark-fields">
      <div className="flex gap-2">
        <Field label="Color">
          <input
            type="color"
            data-testid="mark-color"
            value={hex6(mark.color)}
            onChange={(e) => onPatch((m) => ({ ...m, color: e.target.value }))}
            className={colorCls}
          />
        </Field>
        <Field label={`Stroke · ${mark.widthPx}px`}>
          <Slider
            ariaLabel="Stroke width"
            min={2}
            max={40}
            value={mark.widthPx}
            onChange={(v) => onPatch((m) => ({ ...m, widthPx: v }))}
          />
        </Field>
      </div>

      {box && (
        <>
          <Check
            checked={!!mark.fill}
            onChange={(on) => onPatch((m) => ({ ...m, fill: on ? withAlpha(m.color, DEFAULT_FILL_ALPHA) : null }))}
          >
            Fill
          </Check>
          {mark.fill && (
            <div className="flex gap-2">
              <Field label="Fill color">
                <input
                  type="color"
                  value={hex6(mark.fill)}
                  onChange={(e) => onPatch((m) => ({ ...m, fill: withAlpha(e.target.value, getAlpha(m.fill ?? '')) }))}
                  className={colorCls}
                />
              </Field>
              <Field label={`Fill opacity · ${fillPct(mark.fill)}%`}>
                <Slider
                  ariaLabel="Fill opacity"
                  min={0}
                  max={100}
                  value={fillPct(mark.fill)}
                  onChange={(v) => onPatch((m) => ({ ...m, fill: withAlpha(m.fill ?? m.color, (v / 100) * 255) }))}
                />
              </Field>
            </div>
          )}
          <Check checked={!!mark.lockAspect} onChange={(on) => onPatch((m) => withLockAspect(m, on))}>
            {mark.tool === 'rect' ? 'Square (lock aspect)' : 'Circle (lock aspect)'}
          </Check>
        </>
      )}
      {mark.tool === 'rect' && (
        <Field label={`Corner radius · ${mark.radiusPx ?? 0}px`}>
          <Slider
            ariaLabel="Corner radius"
            min={0}
            max={200}
            value={mark.radiusPx ?? 0}
            onChange={(v) => onPatch((m) => ({ ...m, radiusPx: v || undefined }))}
          />
        </Field>
      )}

      <div className="flex items-end gap-2">
        <Field label="Appears at (s)">
          <NumberInput
            ariaLabel="Appears at"
            step="0.1"
            min={0}
            max={Math.max(0, maxAtSec - 0.05)}
            value={mark.atSec}
            format={(v) => v.toFixed(2)}
            onCommit={(v) => onPatch((m) => ({ ...m, atSec: clampAt(v) }))}
          />
        </Field>
        <button
          type="button"
          className={`${subtleBtnCls} mb-2 shrink-0`}
          title="Make this mark appear at the playhead"
          onClick={() => onPatch((m) => ({ ...m, atSec: clampAt(playheadAtSec()) }))}
        >
          At playhead
        </button>
      </div>
      <Field label="Reveal">
        <select
          data-testid="mark-reveal"
          value={mark.reveal}
          onChange={(e) => onPatch((m) => ({ ...m, reveal: e.target.value as MarkReveal }))}
          className={inputCls}
        >
          {MARK_REVEALS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}
