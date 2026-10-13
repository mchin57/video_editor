/**
 * Shared form/control primitives + Tailwind class constants for the editor's
 * panels (Inspector, popouts, modals, style controls). Before this module these
 * were re-declared per component; import from here instead of re-rolling a
 * labelled field, a checkbox row, or the stock input/button class strings.
 * @see docs/SHARED.md
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '@/state/projectStore'
import { startPointerDrag } from '@/lib/pointerDrag'
import { normalizeDeg } from '@shared/rotation'

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
        useProject.getState().beginGesture()
        // startPointerDrag: window-level release (incl. pointercancel) + the interaction lock.
        startPointerDrag(
          () => {},
          () => useProject.getState().endGesture()
        )
      }}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`${className} accent-sky-400`}
    />
  )
}

/**
 * THE rotation control — one for every rotatable thing (video, image and text
 * layers, captions), paired with the canvas rotate handle. A −180…180 slider
 * (one undo step per drag, via `Slider`) beside a number field for exact
 * angles; typed values are folded into (−180, 180] so 270 reads back as −90.
 * @see shared/rotation.ts
 */
export function AngleField({
  value,
  onChange,
  label = 'Rotation'
}: {
  value: number
  onChange: (deg: number) => void
  label?: string
}): JSX.Element {
  const deg = normalizeDeg(value)
  return (
    <Field label={`${label} · ${Math.round(deg)}°`}>
      <div className="flex items-center gap-2">
        <Slider ariaLabel={label} min={-180} max={180} step={1} value={deg} onChange={onChange} className="min-w-0 flex-1" />
        <NumberInput
          ariaLabel={`${label} degrees`}
          step="1"
          value={deg}
          format={(v) => String(Math.round(v * 10) / 10)}
          onCommit={(v) => onChange(normalizeDeg(v))}
          className={inputCls.replace('w-full', 'w-16 shrink-0')}
        />
      </div>
    </Field>
  )
}

/** One row of a `ContextMenu`. */
export interface ContextMenuItem {
  /** The row's text (also its accessible name). */
  label: string
  /** Runs after the menu has closed. Ignored for a disabled row or one with a `submenu`. */
  onSelect?: () => void
  /** Greyed out and inert; say why in `reason`. */
  disabled?: boolean
  /** Why the row is disabled: shown under the label and as its tooltip. */
  reason?: string
  /** Right-aligned hint (a shortcut, a current value). */
  hint?: string
  /** A check mark in front (e.g. the level a clip is in). When any row of a
   *  panel sets it (true or false), every row keeps the mark's column. */
  checked?: boolean
  /** A nested menu, opened by hovering the row, clicking it, or ArrowRight. */
  submenu?: ContextMenuEntry[]
  testId?: string
}
/** A divider line between groups of rows. */
export const MENU_SEPARATOR = 'separator' as const
export type ContextMenuEntry = ContextMenuItem | typeof MENU_SEPARATOR

/** The floating menu panel and its rows (the File menu's look). */
export const menuPanelCls = 'min-w-[11rem] rounded-lg border border-white/10 bg-zinc-900 p-1 shadow-2xl'
export const menuItemCls =
  'flex w-full items-center justify-between gap-6 rounded px-2 py-1.5 text-left text-xs text-zinc-200 outline-none hover:bg-white/10 focus:bg-white/10'

const MENU_MARGIN = 4

/** Where a panel goes: at a point (the cursor), or beside a row (a submenu). */
type MenuAnchor = { kind: 'point'; x: number; y: number } | { kind: 'row'; rect: DOMRect }

/** Keep a panel of `w`×`h` inside the window: a menu at the cursor shifts
 *  back from the edges; a submenu flips to its row's left side. */
function placePanel(anchor: MenuAnchor, w: number, h: number): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left: number
  let top: number
  if (anchor.kind === 'point') {
    left = Math.min(anchor.x, vw - w - MENU_MARGIN)
    top = Math.min(anchor.y, vh - h - MENU_MARGIN)
  } else {
    left = anchor.rect.right
    if (left + w > vw - MENU_MARGIN) left = anchor.rect.left - w
    top = Math.min(anchor.rect.top - MENU_MARGIN - 1, vh - h - MENU_MARGIN)
  }
  return { left: Math.max(MENU_MARGIN, left), top: Math.max(MENU_MARGIN, top) }
}

const enabledRows = (panel: HTMLElement | null): HTMLElement[] =>
  panel ? [...panel.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')] : []

function MenuPanel({
  items,
  anchor,
  onDone,
  onBack,
  focusFirst
}: {
  items: ContextMenuEntry[]
  anchor: MenuAnchor
  /** Close the whole menu (after a selection). */
  onDone: () => void
  /** ArrowLeft in a submenu: back to its parent row. */
  onBack?: () => void
  /** Focus the first row on opening (a submenu opened from the keyboard). */
  focusFirst?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [openSub, setOpenSub] = useState<{ index: number; focus: boolean } | null>(null)
  const anyChecked = items.some((i) => i !== MENU_SEPARATOR && i.checked !== undefined)

  // Measured and placed once, where it opened; focused so the arrow keys work at once.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos(placePanel(anchor, el.offsetWidth, el.offsetHeight))
    // A submenu opened by hovering leaves focus where it was: closing it again
    // must not drop focus out of the menu.
    if (focusFirst) enabledRows(el)[0]?.focus()
    else if (anchor.kind === 'point') el.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const move = (dir: 1 | -1): void => {
    const rows = enabledRows(ref.current)
    if (!rows.length) return
    const at = rows.indexOf(document.activeElement as HTMLElement)
    rows[at < 0 ? (dir === 1 ? 0 : rows.length - 1) : (at + dir + rows.length) % rows.length].focus()
  }

  const activate = (index: number, viaKey: boolean): void => {
    const item = items[index]
    if (item === MENU_SEPARATOR || item.disabled) return
    if (item.submenu) {
      setOpenSub({ index, focus: viaKey })
      return
    }
    onDone()
    item.onSelect?.()
  }

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className={`z-[650] outline-none ${menuPanelCls}`}
      onContextMenu={(e) => {
        // Portaled, but React still bubbles it to the surface that opened the
        // menu, which would reopen it here.
        e.preventDefault()
        e.stopPropagation()
      }}
      onKeyDown={(e) => {
        // Keys inside the menu never reach the app's shortcuts. A submenu's
        // keys are its own: they stop here before the parent panel sees them.
        e.stopPropagation()
        const at = rowRefs.current.indexOf(document.activeElement as HTMLDivElement)
        const row = at >= 0 ? items[at] : null
        if (e.key === 'ArrowDown') move(1)
        else if (e.key === 'ArrowUp') move(-1)
        else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) activate(at, true)
        else if (e.key === 'ArrowRight' && row && row !== MENU_SEPARATOR && row.submenu) activate(at, true)
        else if (e.key === 'ArrowLeft' && onBack) onBack()
        else return
        e.preventDefault()
      }}
    >
      {items.map((item, i) => {
        if (item === MENU_SEPARATOR) return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-white/10" />
        const inert = !!item.disabled
        const row = rowRefs.current[i]
        return (
          <div
            key={`${item.label}-${i}`}
            ref={(el) => {
              rowRefs.current[i] = el
            }}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={inert || undefined}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openSub?.index === i : undefined}
            title={inert ? item.reason : undefined}
            data-testid={item.testId}
            onMouseEnter={() => setOpenSub(item.submenu && !inert ? { index: i, focus: false } : null)}
            onClick={(e) => {
              // A click inside a nested panel bubbles through this row (the
              // panel is its DOM child); only a click on the row itself counts.
              if ((e.target as HTMLElement).closest('[role="menuitem"]') === e.currentTarget) activate(i, false)
            }}
            className={
              inert
                ? menuItemCls.replace('text-zinc-200', 'text-zinc-500').replace('hover:bg-white/10', 'cursor-not-allowed')
                : `${menuItemCls} cursor-default`
            }
          >
            <span className="flex min-w-0 items-start gap-1.5">
              {anyChecked && <span className="w-3 shrink-0 text-sky-300">{item.checked ? '✓' : ''}</span>}
              <span className="min-w-0">
                <span>{item.label}</span>
                {inert && item.reason && (
                  <span className="mt-0.5 block max-w-[16rem] text-[10px] leading-snug text-zinc-500">{item.reason}</span>
                )}
              </span>
            </span>
            {(item.hint || item.submenu) && (
              <span className="shrink-0 text-[10px] text-zinc-500">{item.submenu ? '▸' : item.hint}</span>
            )}
            {item.submenu && openSub?.index === i && row && (
              <MenuPanel
                items={item.submenu}
                anchor={{ kind: 'row', rect: row.getBoundingClientRect() }}
                onDone={onDone}
                focusFirst={openSub.focus}
                onBack={() => {
                  setOpenSub(null)
                  row.focus()
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * THE right-click menu: a floating panel at the cursor, styled like the File
 * menu. Closes on Escape, a press outside it, a scroll anywhere, a resize, or
 * the window losing focus — and when a row is chosen (the menu closes FIRST,
 * then the row's `onSelect` runs). Disabled rows stay visible, greyed, with
 * their `reason`. A row with `submenu` opens a nested panel beside it (hover,
 * click or ArrowRight; ArrowLeft goes back); submenus nest to any depth.
 * Keyboard: ArrowUp/Down move, Enter/Space choose. Usually driven through
 * `useContextMenu`. @see docs/SHARED.md
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  /** Viewport coordinates (the event's clientX / clientY). */
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const inside = (t: EventTarget | null): boolean => t instanceof Node && !!rootRef.current?.contains(t)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Never let it fall through to the app's Escape (clear selection, …).
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (!inside(e.target)) onClose()
    }
    const onScroll = (e: Event): void => {
      if (!inside(e.target)) onClose()
    }
    const onLeave = (): void => onClose()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [onClose])
  return createPortal(
    <div ref={rootRef}>
      <MenuPanel items={items} anchor={{ kind: 'point', x, y }} onDone={onClose} />
    </div>,
    document.body
  )
}

/**
 * A right-click menu for one surface. `open` is the `onContextMenu` handler —
 * pass the rows then, so they reflect the item's state at that moment — and
 * `menu` is rendered anywhere in the component (it portals to <body>).
 *
 *   const ctx = useContextMenu()
 *   <div onContextMenu={(e) => ctx.open(e, [{ label: 'Rename…', onSelect: … }])}>…</div>
 *   {ctx.menu}
 */
export function useContextMenu(): {
  open: (e: React.MouseEvent, items: ContextMenuEntry[]) => void
  close: () => void
  menu: JSX.Element | null
} {
  const [state, setState] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null)
  const close = useCallback(() => setState(null), [])
  const open = useCallback((e: React.MouseEvent, items: ContextMenuEntry[]) => {
    e.preventDefault()
    e.stopPropagation()
    setState({ x: e.clientX, y: e.clientY, items })
  }, [])
  const menu = state ? <ContextMenu x={state.x} y={state.y} items={state.items} onClose={close} /> : null
  return { open, close, menu }
}
