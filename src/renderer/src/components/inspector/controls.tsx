/** Controls shared by the Inspector's editors: the Default/On/Off override toggle, the stabilization sliders, a live slider that edits through `liveUpdate`, and the linked-tile helpers. */

import { useRef, type JSX } from 'react'
import type { Composition, Layer, Project, Stabilize, TimelineItemKind } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { expandGroup } from '@/lib/links'
import { compositionDuration } from '@shared/compositions'
import { maxItemEndSec } from '@shared/assistant/onScreenText'
import { activeComp, useProject } from '@/state/projectStore'
import { startPointerDrag } from '@/lib/pointerDrag'
import { Field } from '../ui'

export type TriMode = 'default' | 'on' | 'off'
/**
 * Link-group awareness for the editor panels. A tile in a link group moves,
 * splits and deletes with its partners (`lib/links.ts`), so the controls that
 * would silently DESYNC the group — anything that re-times just this tile
 * (start/end, source trim, speed, freezes, detaching audio) — are disabled while
 * it's linked; per-tile looks (crop, colour, gain, style) stay live. Returns the
 * group's size, 1 when the tile is unlinked (the primitive keeps the zustand
 * selector cheap to compare).
 */
export function useLinkGroupSize(kind: TimelineItemKind, id: string | null): number {
  return useProject((s) => {
    const c = activeComp(s)
    return c && id ? expandGroup(c, { kind, id }).length : 1
  })
}
/** The latest a layer or caption may end via its End (s) field: the assistant's
 *  `set_text` rule (`maxItemEndSec`) over the same measure (`compositionDuration`
 *  of the comp being edited), but WITHOUT the layer being edited — End commits
 *  live while typing, so a bound that counted the layer itself would move with
 *  every keystroke. Without it a typo like `1e999` or `300000` crashed or froze
 *  the timeline. */
export function useMaxEndSec(editedLayerId: string | null): number {
  const { data: assets = [] } = useLibrary()
  return useProject((s) => {
    const c = activeComp(s)
    if (!c) return Number.POSITIVE_INFINITY
    const rest = { ...c, layers: c.layers.filter((l) => l.id !== editedLayerId) }
    return maxItemEndSec(compositionDuration(rest, (mid) => assets.find((a) => a.id === mid)?.probe.durationSec ?? 0))
  })
}
/** The banner explaining why this panel's timing controls are greyed out. */
export function LinkedNote({ size }: { size: number }): JSX.Element {
  return (
    <p className="mb-2 rounded bg-sky-500/10 px-2 py-1 text-[10px] leading-snug text-sky-300/90">
      🔗 Linked to {size - 1} other {size === 2 ? 'tile' : 'tiles'} — they move, trim, split and delete together. Drag
      an edge on the timeline to trim the whole group; re-timing just this tile needs{' '}
      <span className="text-sky-200">⛓ Unlink</span>.
    </p>
  )
}
/** Delete this tile — or, when it's linked, its whole group (a group is only
 *  ever removed as a whole). Shared by the three editor panels. */
export function useDeleteTile(kind: TimelineItemKind, id: string | null): () => void {
  const removeItems = useProject((s) => s.removeItems)
  return () => {
    const p = useProject.getState().project
    if (!p || !id) return
    removeItems(expandGroup(p, { kind, id }))
  }
}
/** The shared Default / On / Off segmented control for a tri-state per-clip
 *  override (noise reduction, stabilization). `mode` is the active segment;
 *  `defaultOn` is what the project default currently resolves to. */
export function OverrideToggle({
  label,
  noun,
  effectiveOn,
  defaultOn,
  mode,
  onPick
}: {
  label: string
  noun: string
  effectiveOn: boolean
  defaultOn: boolean
  mode: TriMode
  onPick: (mode: TriMode) => void
}): JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500">→ {effectiveOn ? 'On' : 'Off'}</span>
      </div>
      <div className="flex gap-1">
        {(['default', 'on', 'off'] as const).map((key) => (
          <button
            key={key}
            onClick={() => onPick(key)}
            title={
              key === 'default'
                ? `Follow the project default (${defaultOn ? 'On' : 'Off'})`
                : `Force ${noun} ${key} for this clip`
            }
            className={`flex-1 rounded px-2 py-1 text-[11px] ${
              mode === key ? 'bg-sky-500/30 text-sky-100' : 'bg-white/5 text-zinc-400 hover:bg-white/10'
            }`}
          >
            {key === 'default' ? `Default (${defaultOn ? 'On' : 'Off'})` : key === 'on' ? 'On' : 'Off'}
          </button>
        ))}
      </div>
    </div>
  )
}
/** Shakiness + smoothing sliders for a `Stabilize` value — shared by the per-clip
 *  override, the project default, and the Project settings menu. */
export function StabilizeSliders({
  value,
  onChange
}: {
  value: Stabilize
  onChange: (next: Stabilize) => void
}): JSX.Element {
  return (
    <>
      <Field label={`Shakiness · ${value.shakiness}`}>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={value.shakiness}
          onChange={(e) => onChange({ ...value, shakiness: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
      <Field label={`Smoothing · ${value.smoothing} frames`}>
        <input
          type="range"
          min={1}
          max={40}
          step={1}
          value={value.smoothing}
          onChange={(e) => onChange({ ...value, smoothing: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
    </>
  )
}
/** A range slider that previews live during the drag and records one undo step
 *  on release. `transform` maps (active composition, value) → next comp — the
 *  same indirection every editing action uses, so sliders work inside nested
 *  comps too. */
export function LiveRange({
  min,
  max,
  step,
  value,
  transform
}: {
  min: number
  max: number
  step: number
  value: number
  transform: (c: Composition, v: number) => Composition
}): JSX.Element {
  const before = useRef<Project | null>(null)
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onPointerDown={() => {
        before.current = useProject.getState().project
        // startPointerDrag: a window-level release (incl. pointercancel, or the
        // Inspector unmounting mid-drag) + the interaction lock.
        startPointerDrag(
          () => {},
          () => {
            if (before.current) useProject.getState().commitLive(before.current)
            before.current = null // so later keyboard changes take the commit path
          }
        )
      }}
      onChange={(e) => {
        const v = Number(e.target.value)
        const store = useProject.getState()
        if (before.current) {
          store.liveUpdate((p) => transform(p, v))
          return
        }
        // Keyboard adjustment (no pointer drag in progress): there is no
        // pointerup to close the interaction, so record a normal undo step —
        // otherwise arrow-key changes bypass history, autosave and dirty.
        const prev = store.project
        if (!prev) return
        store.liveUpdate((p) => transform(p, v))
        store.commitLive(prev)
      }}
      className="w-full accent-sky-400"
    />
  )
}
export const setLayer =
  (id: string) =>
  (c: Composition, fn: (l: Layer) => Layer): Composition => ({
    ...c,
    layers: c.layers.map((l) => (l.id === id ? fn(l) : l))
  })
