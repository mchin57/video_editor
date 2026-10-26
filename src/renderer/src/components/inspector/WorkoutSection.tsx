/**
 * Inspector ▸ Workout overlay: which stretch of the recording the tile plays
 * and how fast, and which widgets it shows (docs/WORKOUT-OVERLAY.md). Every
 * timing edit goes through the shared helpers (`withWorkoutSpeed`,
 * `slipWorkout`, …), which keep the tile's length equal to its ride window
 * over its speed.
 */

import { useState, type JSX } from 'react'
import type { Layer, WorkoutContent } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { DEFAULT_DISTANCE_UNITS, sportLabel, type DistanceUnits } from '@shared/workout'
import {
  formatSpeed,
  MAX_WORKOUT_SPEED,
  metricMissing,
  MIN_WORKOUT_SPEED,
  newWidget,
  slipWorkout,
  withWorkoutDuration,
  withWorkoutSpeed,
  workoutPlayedSec,
  workoutSpeed,
  WORKOUT_METRIC_IDS,
  WORKOUT_METRICS,
  type WorkoutMetricId,
  type WorkoutWidget
} from '@shared/workoutOverlay'
import { newId } from '@shared/ids'
import { formatDuration } from '@/lib/format'
import { updateById } from '@/lib/arrays'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { rangesStillMatch, workoutTilesOf, type WorkoutTile } from '@/lib/workoutGraph'
import { WorkoutGraphDialog } from '../WorkoutGraphDialog'
import { CollapsibleSection } from '../CollapsibleSection'
import { Field, NumberInput, Slider, btnCls, colorCls, disabledCls, inputCls } from '../ui'

/** Size ranges per widget kind (canonical px: a readout's number height, a map's width). */
const SIZE_RANGE = { number: { min: 40, max: 320 }, map: { min: 120, max: 1080 } } as const

export function WorkoutSection({
  layer,
  content: c,
  asset,
  linked
}: {
  layer: Layer
  content: WorkoutContent
  asset: MediaAsset | undefined
  /** In a link group: edits that change the tile's length are locked. */
  linked: boolean
}): JSX.Element {
  const updateWidgets = useProject((s) => s.updateWorkoutWidgets)
  const [graph, setGraph] = useState<WorkoutTile[] | null>(null)
  const openGraph = (): void => {
    const comp = activeComp(useProject.getState())
    if (comp) setGraph(workoutTilesOf(comp, c.mediaId))
  }
  const saveGraph = (before: WorkoutTile[], after: WorkoutTile[]): string | null => {
    const comp = activeComp(useProject.getState())
    if (!comp || !rangesStillMatch(comp, before)) {
      return 'The timeline changed while this was open, so nothing was saved. Close and open the graph again.'
    }
    useProject.getState().applyWorkoutRanges(before, after)
    // Keep this tile selected if it survived; else the first range.
    const keep = after.find((t) => t.id === layer.id) ?? after[0]
    if (keep) useUi.getState().selectLayer(keep.id)
    return null
  }
  const update = useProject((s) => s.updateLayer)
  /** Take an edited tile from a shared helper: its window and content together. */
  const apply = (l: Layer): void => update(layer.id, { startSec: l.startSec, endSec: l.endSec, content: l.content })
  const summary = asset?.probe.workout
  const rideDur = asset?.probe.durationSec ?? 0
  const channels = summary?.channels ?? []
  const speed = workoutSpeed(c)
  const lengthLock = linked ? 'Locked while linked: it would change this tile’s length under its group' : undefined

  const widgetFor = (m: WorkoutMetricId): WorkoutWidget | undefined => c.widgets.find((w) => w.metric === m)
  const toggle = (m: WorkoutMetricId, on: boolean): void =>
    updateWidgets(layer.id, (ws) => (on ? [...ws, newWidget(m, ws, newId())] : ws.filter((w) => w.metric !== m)))
  const patchWidget = (w: WorkoutWidget, patch: Partial<WorkoutWidget>): void =>
    updateWidgets(layer.id, (ws) => updateById(ws, w.id, (x) => ({ ...x, ...patch })))

  return (
    <>
      <CollapsibleSection id="workout" title="Workout">
        <p className="mb-2 text-[11px] leading-snug text-zinc-400" data-testid="workout-window">
          {summary ? `${sportLabel(summary.sport)} · ` : ''}
          shows {formatDuration(c.inSec)}–{formatDuration(c.outSec)} of {formatDuration(rideDur)}
          {summary?.startUtc ? ` · recorded ${new Date(summary.startUtc).toLocaleString()}` : ''}
        </p>
        <button
          type="button"
          data-testid="workout-open-graph"
          onClick={openGraph}
          disabled={!asset || asset.status === 'missing'}
          className={`${btnCls} ${disabledCls} mb-2 w-full`}
          title="Graphs of the recording: zoom in, then trim, split or delete what the overlay shows"
        >
          📈 Graph…
        </button>
        <div className="flex gap-2">
          <Field label="Speed (×)">
            <NumberInput
              step="1"
              min={MIN_WORKOUT_SPEED}
              max={MAX_WORKOUT_SPEED}
              value={speed}
              format={(v) => formatSpeed(v)}
              disabled={linked}
              title={lengthLock ?? 'Seconds of the workout per second of video (1 = real time)'}
              onCommit={(v) => apply(withWorkoutSpeed(layer, c, v))}
              className={`${inputCls} ${disabledCls}`}
            />
          </Field>
          <Field label="Length (s)">
            <NumberInput
              step="0.5"
              min={0.2}
              value={workoutPlayedSec(c)}
              format={(v) => v.toFixed(1)}
              disabled={linked}
              title={lengthLock ?? 'How long the tile plays; the speed follows'}
              onCommit={(v) => apply(withWorkoutDuration(layer, c, v))}
              className={`${inputCls} ${disabledCls}`}
            />
          </Field>
        </div>
        <Field label="Starts at (s into the workout)">
          <NumberInput
            step="1"
            min={0}
            value={c.inSec}
            format={(v) => v.toFixed(1)}
            title="Slide the stretch shown (same length and speed) — lines a synced overlay up with its footage by hand"
            onCommit={(v) => apply(slipWorkout(layer, c, v, rideDur))}
          />
        </Field>
        <div className="flex items-end gap-2">
          <Field label="Units">
            <select
              value={c.units ?? DEFAULT_DISTANCE_UNITS}
              onChange={(e) => update(layer.id, { content: { ...c, units: e.target.value as DistanceUnits } })}
              className={inputCls}
            >
              <option value="imperial">Miles</option>
              <option value="metric">Kilometres</option>
            </select>
          </Field>
          <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={!layer.hidden}
              onChange={() => update(layer.id, { hidden: !layer.hidden })}
            />
            Visible
          </label>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="workout-widgets" title="Shows">
        <p className="mb-2 text-[10px] leading-snug text-zinc-500">Drag a widget on the preview to place it.</p>
        <ul className="space-y-2">
          {WORKOUT_METRIC_IDS.map((m) => {
            const metric = WORKOUT_METRICS[m]
            const missing = metricMissing(m, channels)
            const w = widgetFor(m)
            const range = SIZE_RANGE[metric.kind]
            return (
              <li key={m} data-testid={`workout-metric-${m}`}>
                <label
                  className={`flex items-center gap-2 text-xs ${missing ? 'text-zinc-600' : 'text-zinc-200'}`}
                  title={missing ?? undefined}
                >
                  <input
                    type="checkbox"
                    checked={!!w}
                    disabled={!!missing && !w}
                    onChange={(e) => toggle(m, e.target.checked)}
                  />
                  {metric.label}
                  {missing && <span className="text-[10px] text-zinc-600">— {missing}</span>}
                </label>
                {w && (
                  <div className="ml-5 mt-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Slider
                        min={range.min}
                        max={range.max}
                        step={1}
                        value={w.sizePx}
                        ariaLabel={`${metric.label} size`}
                        onChange={(v) => patchWidget(w, { sizePx: v })}
                        className="flex-1"
                      />
                      <input
                        type="color"
                        value={w.color}
                        aria-label={`${metric.label} colour`}
                        onChange={(e) => patchWidget(w, { color: e.target.value })}
                        className={`${colorCls} w-8 shrink-0`}
                      />
                    </div>
                    {m === 'liveMap' && (
                      <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                        <input
                          type="checkbox"
                          checked={!!w.trace}
                          onChange={(e) => patchWidget(w, { trace: e.target.checked || undefined })}
                        />
                        Draw the route as it’s ridden
                      </label>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </CollapsibleSection>
      {graph && asset && (
        <WorkoutGraphDialog
          asset={asset}
          tiles={graph}
          selectedId={layer.id}
          onClose={() => setGraph(null)}
          onSave={saveGraph}
        />
      )}
    </>
  )
}
