/**
 * Shared form/control primitives + Tailwind class constants for the editor's
 * panels (Inspector, popouts, modals, style controls). Before this module these
 * were re-declared per component; import from here instead of re-rolling a
 * labelled field, a checkbox row, or the stock input/button class strings.
 * @see docs/SHARED.md
 */

import type { JSX, ReactNode } from 'react'

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
