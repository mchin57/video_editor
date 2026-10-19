/** Inspector ▸ video layer: playback speed (constant or ramped) and freeze frames — the edits that re-time a clip. */

import { useState, type JSX } from 'react'
import type { Layer, VideoContent } from '@shared/project'
import { MAX_VIDEO_SPEED, MIN_VIDEO_SPEED, videoSpeed } from '@shared/project'
import { videoSourceTime, videoTimelineTime } from '@shared/layers'
import { hasSpeedRamp, sortedRamp } from '@shared/speed'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { Field, NumberInput, disabledCls, inputCls } from '../ui'

/** Freeze-frame controls: hold the current frame for a chosen duration, and list
 *  existing holds. Adding a freeze extends only this clip (no ripple) — which is
 *  why `disabled` (a linked tile) locks both adding and removing. */
export function FreezeFrames({
  layer,
  content,
  disabled
}: {
  layer: Layer
  content: VideoContent
  disabled?: boolean
}): JSX.Element {
  const addFreeze = useProject((s) => s.addFreeze)
  const removeFreeze = useProject((s) => s.removeFreeze)
  const [hold, setHold] = useState(2)
  const freezes = content.freezes ?? []

  return (
    <div>
      <div className="mb-2 flex items-end gap-2">
        <Field label="Hold (s)">
          <NumberInput step="0.5" min={0.1} value={hold} onCommit={setHold} />
        </Field>
        <button
          onClick={() => addFreeze(layer.id, videoSourceTime(content, layer, usePlayback.getState().time), hold)}
          disabled={disabled}
          className={`mb-2 flex-1 rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 ${disabledCls}`}
          title={
            disabled
              ? 'Not available on a linked tile — a freeze would stretch only this one (unlink first)'
              : 'Hold the frame at the playhead for the chosen duration'
          }
        >
          ⏸ Pause clip here
        </button>
      </div>
      {freezes.length === 0 ? (
        <p className="text-[11px] text-zinc-600">No freezes. Move the playhead and add one.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {freezes.map((f, i) => (
            <li
              key={i}
              className="flex items-center justify-between rounded bg-black/30 px-2 py-1 text-[11px] text-zinc-300"
            >
              <span>
                @ {Math.max(0, f.atSec - content.inSec).toFixed(1)}s into clip · hold {f.holdSec.toFixed(1)}s
              </span>
              <button
                onClick={() => removeFreeze(layer.id, i)}
                disabled={disabled}
                className={`rounded px-1 text-rose-300 hover:bg-rose-500/20 ${disabledCls}`}
                title="Remove this freeze"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4]
/** Clip speed: constant presets + a free field, plus a keyframed speed RAMP.
 *  Everything commits through store actions so `endSec` keeps the shared
 *  duration invariant (`playedBetween(in, out) + freeze holds`) and each
 *  change is one undo step. With a ramp active the constant controls disable
 *  (the ramp overrides them) and the clip's own audio is muted — no
 *  variable-tempo audio path, preview and export agree. `disabled` locks the
 *  whole section for a LINKED tile: re-timing one member would desync the group. */
export function SpeedControl({
  layer,
  content,
  disabled
}: {
  layer: Layer
  content: VideoContent
  disabled?: boolean
}): JSX.Element {
  const layerId = layer.id
  const setSpeed = useProject((s) => s.setVideoSpeed)
  const addRampKf = useProject((s) => s.addSpeedKeyframe)
  const updateRampKf = useProject((s) => s.updateSpeedKeyframe)
  const removeRampKf = useProject((s) => s.removeSpeedKeyframe)
  const clearRamp = useProject((s) => s.clearSpeedRamp)
  const setTime = usePlayback((s) => s.setTime)
  const cur = videoSpeed(content)
  const ramped = hasSpeedRamp(content)
  const ramp = sortedRamp(content)
  return (
    // Outer wrapper keeps pointer events so the "why" tooltip still shows.
    <div title={disabled ? 'Not available on a linked tile — re-timing one member would desync the group' : undefined}>
      <div className={disabled ? 'pointer-events-none opacity-40' : ''}>
        <Field label={`Speed · ${ramped ? 'ramp' : `${cur}×`}`}>
          <div className={`flex flex-wrap gap-1 ${ramped ? 'pointer-events-none opacity-40' : ''}`}>
            {SPEED_PRESETS.map((v) => (
              <button
                key={v}
                onClick={() => setSpeed(layerId, v)}
                disabled={ramped}
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  !ramped && cur === v ? 'bg-sky-500/40 text-sky-100' : 'bg-white/10 text-zinc-300 hover:bg-white/20'
                }`}
                title={v < 1 ? `Slow motion (${v}×)` : v > 1 ? `Speed up (${v}×)` : 'Normal speed'}
              >
                {v}×
              </button>
            ))}
            <NumberInput
              min={MIN_VIDEO_SPEED}
              max={MAX_VIDEO_SPEED}
              step={0.05}
              value={cur}
              disabled={ramped}
              onCommit={(v) => setSpeed(layerId, v)}
              className={`${inputCls} w-16 flex-none`}
            />
          </div>
        </Field>
        <div className="mt-1">
          <button
            onClick={() => addRampKf(layerId, usePlayback.getState().time)}
            className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            title="Keyframe the playback speed at the playhead — speed ramps linearly between keyframes"
          >
            ＋ Speed keyframe at playhead
          </button>
          {ramped && (
            <>
              <ul className="mt-1.5 space-y-1">
                {ramp.map((k, i) => (
                  <li
                    key={`${k.atSec}-${i}`}
                    className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300"
                  >
                    <button
                      onClick={() => setTime(videoTimelineTime(content, layer, k.atSec))}
                      className="rounded bg-white/10 px-1 text-zinc-200 hover:bg-white/20"
                      title="Jump the playhead to this speed keyframe"
                    >
                      ▸
                    </button>
                    <span className="w-10 font-mono">{k.atSec.toFixed(2)}s</span>
                    <NumberInput
                      min={MIN_VIDEO_SPEED}
                      max={MAX_VIDEO_SPEED}
                      step={0.05}
                      value={k.speed}
                      onCommit={(v) => updateRampKf(layerId, i, v)}
                      className={`${inputCls} w-14 flex-none`}
                      title="Playback speed at this source point"
                    />
                    <span className="flex-1 text-zinc-500">×</span>
                    <button
                      onClick={() => removeRampKf(layerId, i)}
                      className="text-zinc-500 hover:text-rose-400"
                      title="Remove this speed keyframe"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => clearRamp(layerId)}
                className="mt-1.5 w-full rounded bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/10"
              >
                Clear speed ramp
              </button>
              <p className="mt-1 text-[10px] leading-snug text-zinc-500">
                Speed ramps linearly between keyframes (times are source seconds) and holds flat outside them. The
                clip&apos;s own audio is muted while a ramp is active.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
