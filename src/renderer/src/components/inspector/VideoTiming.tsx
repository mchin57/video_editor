/** Inspector ▸ video layer: playback speed (constant or ramped) and freeze frames — the edits that re-time a clip. */

import { useState, type JSX } from 'react'
import type { Layer, VideoContent } from '@shared/project'
import { MAX_VIDEO_SPEED, MIN_VIDEO_SPEED, videoSpeed } from '@shared/project'
import { videoSourceTime, videoTimelineTime } from '@shared/layers'
import { hasSpeedRamp, sortedRamp } from '@shared/speed'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { Field, NumberInput, disabledCls, inputCls } from '../ui'
import { LockedBy, SpeedPresets } from './SpeedPresets'

/** Freeze-frame controls: hold the current frame for a chosen duration, and list
 *  existing holds. Adding a freeze extends only this clip (no ripple) — and, on
 *  a linked clip, its same-source audio by the same hold (silence), through the
 *  store's group-aware actions. `lock` (`retimeLock`: a linked caption) says
 *  why both adding and removing are unavailable. */
export function FreezeFrames({
  layer,
  content,
  lock
}: {
  layer: Layer
  content: VideoContent
  lock?: string | null
}): JSX.Element {
  const disabled = !!lock
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
            lock ?? 'Hold the frame at the playhead for the chosen duration (its linked audio falls silent for it)'
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
                title={lock ?? 'Remove this freeze'}
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
/** Clip speed: constant presets + a free field (`SpeedPresets`, shared with
 *  audio clips), plus a keyframed speed RAMP. Everything commits through store
 *  actions so `endSec` keeps the shared duration invariant
 *  (`playedBetween(in, out) + freeze holds`) and each change is one undo step;
 *  a constant speed on a LINKED clip re-times its same-source audio with it
 *  (`setGroupSpeed`). With a ramp active the constant controls disable (the
 *  ramp overrides them) and the clip's own audio is muted — no variable-tempo
 *  audio path, preview and export agree. `lock` (`retimeLock`) locks the
 *  constant speed; `rampLock` the ramp, which stays locked on every linked
 *  tile (audio clips have no ramp yet). */
export function SpeedControl({
  layer,
  content,
  lock,
  rampLock
}: {
  layer: Layer
  content: VideoContent
  lock?: string | null
  rampLock?: string | null
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
    <div>
      <LockedBy lock={lock ?? null}>
        <SpeedPresets
          value={cur}
          label={ramped ? 'ramp' : undefined}
          inactive={ramped}
          onPick={(v) => setSpeed(layerId, v)}
        />
      </LockedBy>
      <LockedBy lock={rampLock ?? null}>
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
      </LockedBy>
    </div>
  )
}
