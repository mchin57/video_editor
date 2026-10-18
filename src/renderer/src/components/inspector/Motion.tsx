/** Inspector ▸ layer motion: the straight-line Motion editor and the keyframe list. */

import { useState, type JSX } from 'react'
import type { Layer } from '@shared/project'
import { kfOpacity, layerTransformAt, type FrameRect } from '@shared/layers'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { Field, NumberInput, btnCls, inputCls, subtleBtnCls } from '../ui'
import {
  DEFAULT_MOTION_SEC,
  MIN_MOTION_SEC,
  editSimpleMotion,
  isSimpleMotion,
  newMotionKeyframes,
  simpleMotion
} from '@shared/motion'

/**
 * Position/scale keyframes for a media layer. "＋ Keyframe" captures the
 * layer's effective transform at the playhead; with keyframes present, canvas
 * drags/corner-resizes write keyframes at the playhead too (PreviewStage).
 * Motion previews and exports through the same shared interpolation
 * (`layerTransformAt`).
 */
/**
 * The simple Motion editor: "Add motion" starts a straight-line move AT THE
 * PLAYHEAD from where the layer is now; then the start/end points, start time
 * and duration are editable here (and the two points by dragging their dots on
 * the canvas). Points read frame-relative like Position X/Y. A layer whose
 * keyframes are not a simple move says so instead of guessing.
 */
export function MotionFields({ layer, frame }: { layer: Layer; frame: FrameRect }): JSX.Element {
  const update = useProject((s) => s.updateLayer)
  const [durSec, setDurSec] = useState(DEFAULT_MOTION_SEC)
  const kfs = layer.keyframes
  const len = Math.max(0, layer.endSec - layer.startSec)
  const isText = layer.content.kind === 'text'

  if (!kfs || kfs.length === 0) {
    const add = (): void => {
      const t = usePlayback.getState().time
      const tr = layerTransformAt(layer, t)
      update(layer.id, { keyframes: newMotionKeyframes(tr, t - layer.startSec, durSec, len, frame) })
    }
    return (
      <>
        <p className="mb-2 text-[10px] leading-snug text-zinc-500">
          Moves in a straight line from where it is now, starting at the playhead. Then drag the dots on the preview to
          set where it starts and ends.
        </p>
        <div className="flex items-end gap-2">
          <Field label="Duration (s)">
            <NumberInput
              step="0.1"
              min={MIN_MOTION_SEC}
              value={durSec}
              format={(v) => v.toFixed(1)}
              onCommit={setDurSec}
            />
          </Field>
          <button type="button" onClick={add} className={`${btnCls} mb-2 shrink-0`}>
            ➜ Add motion
          </button>
        </div>
      </>
    )
  }

  const remove = (
    <button
      type="button"
      className={`${subtleBtnCls} w-full`}
      // Leave the layer where its move starts, rather than jumping back to a
      // base position nobody has seen since the move was added.
      onClick={() => {
        const first = [...kfs].sort((a, b) => a.tSec - b.tSec)[0]
        update(layer.id, { keyframes: undefined, x: first.x, y: first.y })
      }}
    >
      Remove motion
    </button>
  )

  if (!isSimpleMotion(kfs)) {
    return (
      <>
        <p className="mb-2 text-[10px] leading-snug text-zinc-500">
          {kfs.length} keyframes — more than a simple start → end move.
          {isText ? ' The text follows the first stretch that moves.' : ' Edit them under Keyframes.'}
        </p>
        {isText && remove}
      </>
    )
  }

  const mo = simpleMotion(kfs)
  const edit = (patch: Parameters<typeof editSimpleMotion>[1]): void =>
    update(layer.id, { keyframes: editSimpleMotion(kfs, patch, len) })
  const coord = (label: string, v: number, origin: number, key: 'x0' | 'y0' | 'x1' | 'y1'): JSX.Element => (
    <Field label={label}>
      <NumberInput step="5" value={Math.round(v - origin)} onCommit={(n) => edit({ [key]: n + origin })} />
    </Field>
  )
  return (
    <>
      <div className="flex gap-2">
        {coord('Start X', mo.x0, frame.x, 'x0')}
        {coord('Start Y', mo.y0, frame.y, 'y0')}
      </div>
      <div className="flex gap-2">
        {coord('End X', mo.x1, frame.x, 'x1')}
        {coord('End Y', mo.y1, frame.y, 'y1')}
      </div>
      <div className="flex gap-2">
        <Field label="Starts at (s)">
          <NumberInput step="0.1" min={0} value={mo.t0} format={(v) => v.toFixed(1)} onCommit={(t0) => edit({ t0 })} />
        </Field>
        <Field label="Duration (s)">
          <NumberInput
            step="0.1"
            min={MIN_MOTION_SEC}
            value={mo.t1 - mo.t0}
            format={(v) => v.toFixed(1)}
            onCommit={(d) => edit({ durSec: d })}
          />
        </Field>
      </div>
      {remove}
    </>
  )
}
export function KeyframesSection({
  layer,
  frame,
  zoomBase
}: {
  layer: Layer
  /** Keyframe values display frame-relative, like the Transform fields. */
  frame: FrameRect
  zoomBase: number
}): JSX.Element {
  const addKf = useProject((s) => s.addLayerKeyframe)
  const removeKf = useProject((s) => s.removeLayerKeyframe)
  const clearKfs = useProject((s) => s.clearLayerKeyframes)
  const setKfOpacity = useProject((s) => s.setLayerKeyframeOpacity)
  const setTime = usePlayback((s) => s.setTime)
  const kfs = [...(layer.keyframes ?? [])].sort((a, b) => a.tSec - b.tSec)
  return (
    <div>
      <button
        onClick={() => addKf(layer.id, usePlayback.getState().time)}
        className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        title="Capture the layer's position & zoom at the playhead as a keyframe"
      >
        ＋ Keyframe at playhead
      </button>
      {kfs.length > 0 && (
        <>
          <ul className="mt-1.5 space-y-1">
            {kfs.map((k, i) => (
              <li
                key={`${k.tSec}-${i}`}
                className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300"
              >
                <button
                  onClick={() => setTime(layer.startSec + k.tSec)}
                  className="rounded bg-white/10 px-1 text-zinc-200 hover:bg-white/20"
                  title="Jump the playhead to this keyframe"
                >
                  ▸
                </button>
                <span className="w-10 font-mono">{k.tSec.toFixed(2)}s</span>
                <span className="flex-1 truncate text-zinc-500">
                  x{Math.round(k.x - frame.x)} y{Math.round(k.y - frame.y)} · {Math.round((k.scale / zoomBase) * 100)}%
                </span>
                <NumberInput
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(kfOpacity(k) * 100)}
                  onCommit={(v) => setKfOpacity(layer.id, i, v / 100)}
                  className={`${inputCls} w-12 flex-none`}
                  title="Layer opacity at this keyframe (%) — fades linearly between keyframes"
                />
                <button
                  onClick={() => removeKf(layer.id, i)}
                  className="text-zinc-500 hover:text-rose-400"
                  title="Remove this keyframe"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => clearKfs(layer.id)}
            className="mt-1.5 w-full rounded bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/10"
          >
            Clear all keyframes
          </button>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Motion (and the % opacity) is linear between keyframes and holds outside them. Dragging the layer on the
            canvas updates the keyframe at the playhead.
          </p>
        </>
      )}
    </div>
  )
}
