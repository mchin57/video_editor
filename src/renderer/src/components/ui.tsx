/**
 * Shared form/control primitives + Tailwind class constants for the editor's
 * panels (Inspector, popouts, modals, style controls). Before this module these
 * were re-declared per component; import from here instead of re-rolling a
 * labelled field, a checkbox row, or the stock input/button class strings.
 * @see docs/SHARED.md
 */

import { useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useProject } from '@/state/projectStore'

/** Stock text/number input. */
export const inputCls =
  'w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-400/60'

/** Stock `<input type="color">`. */
export const colorCls = 'h-7 w-full rounded border border-white/10 bg-black/40'

/** Neutral action button (compose with layout utilities like `w-full`/`mt-2`). */
export const btnCls = 'rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20'

/** Quieter secondary button (e.g. "Remove", "Reset"). */
export const subtleBtnCls = 'rounded bg-white/5 px-2 py-1.5 text-xs text-zinc-400 hover:bg-white/10'

/** Destructive button (delete/remove). */
export const dangerBtnCls = 'rounded bg-rose-500/20 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/30'

/** Appended to an input/button disabled for a STRUCTURAL reason (a tile in a
 *  link group, a re-timed clip) — one home for the greyed-out + not-allowed look. */
export const disabledCls = 'disabled:cursor-not-allowed disabled:opacity-40'

/** On/off pill (segmented toggle, flip-state button). */
export const toggleCls = (on: boolean): string =>
  `rounded px-2 py-1.5 text-xs ${on ? 'bg-sky-500 text-white' : 'bg-white/10 text-zinc-200 hover:bg-white/20'}`

/** A labelled control: small uppercase caption above its input. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

/** A label/value read-only row (used for source metadata). */
export function Row({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-2 py-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-300">{children}</span>
    </div>
  )
}

/** A checkbox with an inline label. */
export function Check({
  checked,
  onChange,
  children
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}): JSX.Element {
  return (
    <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

/**
 * Stock numeric input that does NOT fight the user mid-typing.
 *
 * A plain `<input type="number">` bound to `value` with a clamp in `onChange`
 * re-renders the clamped number back into the field on every keystroke, so the
 * field can never be empty and can never hold an intermediate value below the
 * minimum ("" and "1" on the way to "12" both snap to 12). Instead this keeps a
 * DRAFT string while the user is typing: an in-range value commits live (so the
 * preview still follows every keystroke), while an empty/partial/out-of-range
 * one is held in the draft and only clamped + committed on blur or Enter.
 * Escape abandons the draft. `format` controls the resting display only — it is
 * never applied to what the user is currently typing.
 */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  step,
  format,
  disabled,
  className = inputCls,
  title,
  ariaLabel
}: {
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number | string
  format?: (v: number) => string
  disabled?: boolean
  className?: string
  title?: string
  /** Accessible name, for a field that shares its `Field` label with another
   *  control (a label only names its FIRST control). */
  ariaLabel?: string
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  // The draft is mirrored in a ref because `commit` runs from `onBlur`, which
  // Escape triggers in the same tick it abandons the draft — reading the state
  // there would still see the abandoned text and commit it.
  const draftRef = useRef<string | null>(null)
  const putDraft = (v: string | null): void => {
    draftRef.current = v
    setDraft(v)
  }
  const clamp = (v: number): number =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, v))

  const commit = (): void => {
    const d = draftRef.current
    if (d === null) return
    const n = Number(d)
    // An unparseable/empty draft reverts to the last good value rather than
    // committing NaN; clearing a field is a typing state, not an edit.
    if (d.trim() !== '' && Number.isFinite(n)) onCommit(clamp(n))
    putDraft(null)
  }

  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={className}
      value={draft ?? (format ? format(value) : String(value))}
      onChange={(e) => {
        const raw = e.target.value
        putDraft(raw)
        const n = Number(raw)
        // Live-commit only what needs no clamping — anything else waits for blur.
        if (raw.trim() !== '' && Number.isFinite(n) && clamp(n) === n) onCommit(n)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          putDraft(null)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * Stock range slider whose whole DRAG is one undo step. `onChange` edits through
 * ordinary store actions (e.g. an Inspector `onPatch`); the pointer drag is
 * wrapped in a store gesture (`beginGesture`/`endGesture`), so the preview
 * follows every tick but history records the drag once. Keyboard steps (no
 * drag open) record one step each, like any other edit. The gesture closes on
 * a window-level pointerup, so releasing off the thumb still records it.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  title,
  ariaLabel,
  className = 'w-full'
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** Sizing only (default full width); the accent is fixed. */
  className?: string
}): JSX.Element {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      // Clamp only the thumb: a value typed past the range (e.g. a 600px font
      // in the paired number field) parks the thumb at the end, unchanged.
      value={Math.min(max, Math.max(min, value))}
      onPointerDown={() => {
        const store = useProject.getState()
        store.beginGesture()
        const end = (): void => useProject.getState().endGesture()
        window.addEventListener('pointerup', end, { once: true })
        window.addEventListener('pointercancel', end, { once: true })
      }}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`${className} accent-sky-400`}
    />
  )
}
