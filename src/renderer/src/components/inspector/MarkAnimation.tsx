/** Inspector ▸ graphics ▸ the selected mark's Animation: its size / rotation / opacity (and, once keyframed, offset and how much is drawn) at the playhead, and its keyframe list. */

import type { JSX } from 'react'
import type { GraphicMark } from '@shared/graphics'
import {
  addMarkKeyframeAt,
  clearMarkKeyframes,
  EASINGS,
  editPoseAt,
  markPoseAt,
  removeMarkKeyframe,
  retimeMarkKeyframe,
  type Easing,
  type MarkPose
} from '@shared/markAnim'
import {
  canConvertPresets,
  convertPresetsToKeyframes,
  DEFAULT_ENTRANCE_SEC,
  DEFAULT_EXIT_SEC,
  DEFAULT_LOOP_SEC,
  ENTRANCES,
  EXITS,
  hasLivePresets,
  LOOPS,
  MIN_PRESET_SEC,
  type EntranceKind,
  type ExitKind,
  type LoopKind
} from '@shared/markPresets'
import { usePlayback } from '@/state/playback'
import { Field, NumberInput, inputCls, subtleBtnCls } from '../ui'

const whole = (v: number): string => String(Math.round(v))

/**
 * Animation of one mark. Every value shown is the mark's pose AT THE PLAYHEAD
 * (`localSec`), and every edit goes through `editPoseAt` — so with keyframes it
 * writes a keyframe there, without it writes the static value.
 */
export function MarkAnimation({
  layerStartSec,
  layerDurSec,
  mark,
  localSec,
  localNow,
  onPatch
}: {
  layerStartSec: number
  /** The layer's length: keyframes can't be retimed past it. */
  layerDurSec: number
  mark: GraphicMark
  /** The playhead, in seconds after the layer's start (drives the displayed values). */
  localSec: number
  /** The same, read fresh when an edit lands. */
  localNow: () => number
  onPatch: (fn: (m: GraphicMark) => GraphicMark) => void
}): JSX.Element {
  const pose = markPoseAt(mark, localSec)
  const convertCheck = canConvertPresets(mark, layerDurSec)
  const kfs = mark.keyframes ?? []
  const keyframed = kfs.length > 0
  const edit = (patch: Partial<MarkPose>): void => onPatch((m) => editPoseAt(m, localNow(), patch))
  const setTime = usePlayback((s) => s.setTime)

  return (
    <div data-testid="mark-animation" className="mt-2 border-t border-white/10 pt-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Animation</div>
      <div className="flex items-end gap-2">
        <Field label="Entrance">
          <select
            data-testid="mark-entrance"
            value={mark.entrance.kind}
            onChange={(e) => {
              const kind = e.target.value as EntranceKind
              onPatch((m) => ({ ...m, entrance: { kind, sec: DEFAULT_ENTRANCE_SEC[kind] } }))
            }}
            className={inputCls}
          >
            {ENTRANCES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {mark.entrance.kind !== 'instant' && (
          <Field label="Length (s)">
            <NumberInput
              ariaLabel="Entrance length"
              step="0.05"
              min={MIN_PRESET_SEC}
              value={mark.entrance.sec}
              format={(v) => v.toFixed(2)}
              onCommit={(v) =>
                onPatch((m) => ({ ...m, entrance: { ...m.entrance, sec: Math.max(MIN_PRESET_SEC, v) } }))
              }
            />
          </Field>
        )}
      </div>
      <div className="flex items-end gap-2">
        <Field label="Exit">
          <select
            data-testid="mark-exit"
            value={mark.exit?.kind ?? 'none'}
            onChange={(e) => {
              const kind = e.target.value as ExitKind
              onPatch((m) => {
                const { exit: _gone, ...rest } = m
                void _gone
                return kind === 'none' ? rest : { ...rest, exit: { kind, sec: DEFAULT_EXIT_SEC } }
              })
            }}
            className={inputCls}
          >
            {EXITS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {mark.exit && (
          <Field label="Length (s)">
            <NumberInput
              ariaLabel="Exit length"
              step="0.05"
              min={MIN_PRESET_SEC}
              value={mark.exit.sec}
              format={(v) => v.toFixed(2)}
              onCommit={(v) =>
                onPatch((m) => (m.exit ? { ...m, exit: { ...m.exit, sec: Math.max(MIN_PRESET_SEC, v) } } : m))
              }
            />
          </Field>
        )}
      </div>
      <div className="flex items-end gap-2">
        <Field label="Loop">
          <select
            data-testid="mark-loop"
            value={mark.loop?.kind ?? 'none'}
            onChange={(e) => {
              const kind = e.target.value as LoopKind
              onPatch((m) => {
                const { loop: _gone, ...rest } = m
                void _gone
                return kind === 'none' ? rest : { ...rest, loop: { kind, cycleSec: DEFAULT_LOOP_SEC[kind] } }
              })
            }}
            className={inputCls}
          >
            {LOOPS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {mark.loop && (
          <Field label="Cycle (s)">
            <NumberInput
              ariaLabel="Loop cycle length"
              step="0.05"
              min={MIN_PRESET_SEC}
              value={mark.loop.cycleSec}
              format={(v) => v.toFixed(2)}
              onCommit={(v) =>
                onPatch((m) => (m.loop ? { ...m, loop: { ...m.loop, cycleSec: Math.max(MIN_PRESET_SEC, v) } } : m))
              }
            />
          </Field>
        )}
      </div>
      <button
        type="button"
        data-testid="mark-convert-presets"
        className={`${subtleBtnCls} mb-1 w-full`}
        disabled={(!hasLivePresets(mark) && mark.entrance.kind === 'instant') || !convertCheck.ok}
        title={convertCheck.reason ?? 'Turn the entrance, exit and loop into keyframes you can edit'}
        onClick={() => onPatch((m) => convertPresetsToKeyframes(m, layerDurSec))}
      >
        Convert to keyframes
      </button>
      <p className="mb-2 text-[10px] leading-snug text-zinc-500">
        Presets play on top of the keyframes below. Convert turns them into editable keyframes.
      </p>
      <div className="flex gap-2">
        <Field label="Size %">
          <NumberInput
            ariaLabel="Mark size %"
            step={5}
            min={1}
            max={2000}
            value={pose.scale * 100}
            format={whole}
            onCommit={(v) => edit({ scale: v / 100 })}
          />
        </Field>
        <Field label="Rotation °">
          <NumberInput
            ariaLabel="Mark rotation"
            step={5}
            value={pose.rotationDeg}
            format={whole}
            onCommit={(v) => edit({ rotationDeg: v })}
          />
        </Field>
        <Field label="Opacity %">
          <NumberInput
            ariaLabel="Mark opacity %"
            step={5}
            min={0}
            max={100}
            value={pose.opacity * 100}
            format={whole}
            onCommit={(v) => edit({ opacity: v / 100 })}
          />
        </Field>
      </div>
      {keyframed && (
        <div className="flex gap-2">
          <Field label="Move X (px)">
            <NumberInput
              ariaLabel="Mark move X"
              step={10}
              value={pose.dx}
              format={whole}
              onCommit={(v) => edit({ dx: v })}
            />
          </Field>
          <Field label="Move Y (px)">
            <NumberInput
              ariaLabel="Mark move Y"
              step={10}
              value={pose.dy}
              format={whole}
              onCommit={(v) => edit({ dy: v })}
            />
          </Field>
          <Field label="Drawn %">
            <NumberInput
              ariaLabel="Mark drawn %"
              step={5}
              min={0}
              max={100}
              value={pose.drawn * 100}
              format={whole}
              onCommit={(v) => edit({ drawn: v / 100 })}
            />
          </Field>
        </div>
      )}

      <button
        type="button"
        data-testid="mark-add-keyframe"
        className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        title="Capture the shape's values at the playhead as a keyframe"
        onClick={() => onPatch((m) => addMarkKeyframeAt(m, localNow()))}
      >
        ＋ Keyframe at playhead
      </button>

      {keyframed && (
        <ul className="mt-1.5 space-y-1" data-testid="mark-keyframes">
          {kfs.map((k, i) => (
            <li
              key={`${k.tSec}-${i}`}
              className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300"
            >
              <button
                type="button"
                onClick={() => setTime(layerStartSec + k.tSec)}
                className="rounded bg-white/10 px-1 text-zinc-200 hover:bg-white/20"
                title="Jump the playhead to this keyframe"
              >
                ▸
              </button>
              <NumberInput
                ariaLabel={`Keyframe ${i + 1} time`}
                min={0}
                step="0.1"
                value={k.tSec}
                format={(v) => v.toFixed(2)}
                onCommit={(v) => onPatch((m) => retimeMarkKeyframe(m, i, v, layerDurSec))}
                className={`${inputCls} w-16 flex-none`}
                title="Keyframe time (s after the tile's start)"
              />
              <select
                data-testid={`mark-kf-easing-${i}`}
                aria-label={`Keyframe ${i + 1} easing`}
                value={k.easing}
                title="How the stretch from this keyframe to the next eases"
                onChange={(e) =>
                  onPatch((m) => ({
                    ...m,
                    keyframes: (m.keyframes ?? []).map((x, j) =>
                      j === i ? { ...x, easing: e.target.value as Easing } : x
                    )
                  }))
                }
                className={`${inputCls} min-w-0 flex-1`}
              >
                {EASINGS.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid={`mark-kf-remove-${i}`}
                onClick={() => onPatch((m) => removeMarkKeyframe(m, i, localNow()))}
                className="text-zinc-500 hover:text-rose-400"
                title="Remove this keyframe"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {keyframed && (
        <button
          type="button"
          data-testid="mark-clear-keyframes"
          className="mt-1.5 w-full rounded bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/10"
          title="Remove every keyframe, leaving the shape as it looks at the playhead"
          onClick={() => onPatch((m) => clearMarkKeyframes(m, localNow()))}
        >
          Clear all keyframes
        </button>
      )}
      <button
        type="button"
        data-testid="mark-centre-pivot"
        className={`${subtleBtnCls} mt-1.5 w-full`}
        disabled={!mark.pivot}
        title="Put the pivot back at the centre of the shape"
        onClick={() => onPatch((m) => ({ ...m, pivot: undefined }))}
      >
        Centre pivot
      </button>
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Values ease between keyframes and hold outside them. With keyframes, dragging the shape or editing a value
        writes a keyframe at the playhead. Drag the crosshair on the preview to move the pivot.
      </p>
    </div>
  )
}
