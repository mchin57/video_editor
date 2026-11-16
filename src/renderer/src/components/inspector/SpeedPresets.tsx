/** Inspector ▸ the constant-speed control shared by video layers (`VideoTiming`)
 *  and audio clips (`AudioClipEditor`): presets plus a free field over the one
 *  speed range (`MIN_VIDEO_SPEED`..`MAX_VIDEO_SPEED`, shared/speed.ts). */

import type { JSX } from 'react'
import { MAX_VIDEO_SPEED, MIN_VIDEO_SPEED } from '@shared/project'
import { Field, NumberInput, inputCls } from '../ui'

export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4]

/**
 * The speed presets and field. `value` is the clip's effective constant speed;
 * `onPick` commits a new one (the caller's store action keeps the timing
 * invariants and links). `label` replaces the "N×" in the field label (a ramp
 * says "ramp"); `inactive` greys and disables the controls without a reason of
 * their own (a ramp overrides them) — a LOCK with a reason is the caller's
 * wrapper, so its tooltip can cover more than this control.
 */
export function SpeedPresets({
  value,
  onPick,
  label,
  inactive
}: {
  value: number
  onPick: (speed: number) => void
  label?: string
  inactive?: boolean
}): JSX.Element {
  return (
    <Field label={`Speed · ${label ?? `${value}×`}`}>
      <div className={`flex flex-wrap gap-1 ${inactive ? 'pointer-events-none opacity-40' : ''}`}>
        {SPEED_PRESETS.map((v) => (
          <button
            key={v}
            onClick={() => onPick(v)}
            disabled={inactive}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              !inactive && value === v ? 'bg-sky-500/40 text-sky-100' : 'bg-white/10 text-zinc-300 hover:bg-white/20'
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
          value={value}
          disabled={inactive}
          onCommit={onPick}
          className={`${inputCls} w-16 flex-none`}
        />
      </div>
    </Field>
  )
}

/** Wraps controls that a `lock` reason disables: greyed and inert, while the
 *  outer element keeps pointer events so the reason still shows as a tooltip. */
export function LockedBy({ lock, children }: { lock: string | null; children: JSX.Element }): JSX.Element {
  return (
    <div title={lock ?? undefined}>
      <div className={lock ? 'pointer-events-none opacity-40' : ''}>{children}</div>
    </div>
  )
}
