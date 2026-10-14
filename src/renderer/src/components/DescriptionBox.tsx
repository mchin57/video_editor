import { useEffect, useRef, useState, type JSX } from 'react'
import { DESCRIPTION_MAX, normalizeDescription, type MediaAsset } from '@shared/media'
import { useSetDescription } from '@/hooks/useMedia'

/**
 * A clip's description (`MediaRecord.description`), editable in place. The
 * library's hover pop-out and the timeline's hover box both render it, and
 * the assistant writes it with `add_description` (docs/SHARED.md). Click in and type; Enter (or leaving the
 * box) saves, Shift+Enter is a new line, Escape puts back the saved text. It
 * reports focus so its panel stays open while you type (`HoverIntent.pin`).
 *
 * The box sits in a portal, but React events still bubble to the card or tile
 * that owns it — clicks, drags and right-clicks inside stop here.
 */
export function DescriptionBox({
  asset,
  rows = 4,
  className = '',
  onFocusChange
}: {
  asset: MediaAsset
  rows?: number
  className?: string
  onFocusChange?: (focused: boolean) => void
}): JSX.Element {
  const save = useSetDescription()
  const saved = asset.description ?? ''
  const [draft, setDraft] = useState(saved)
  const [focused, setFocused] = useState(false)
  // Follow the saved text (another view, the assistant) unless mid-edit.
  useEffect(() => {
    if (!focused) setDraft(saved)
  }, [saved, focused])

  const latest = useRef({ draft, saved, focused, id: asset.id })
  latest.current = { draft, saved, focused, id: asset.id }
  const skipCommit = useRef(false)
  const commit = (): void => {
    const l = latest.current
    if (normalizeDescription(l.draft) !== l.saved) save.mutate({ id: l.id, text: l.draft })
  }
  // Closed while typing (the panel's owner went away): keep what was typed.
  useEffect(
    () => () => {
      if (latest.current.focused) commit()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()
  return (
    <textarea
      data-testid="description-input"
      value={draft}
      rows={rows}
      maxLength={DESCRIPTION_MAX}
      spellCheck
      placeholder="Add a description…"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        setFocused(true)
        onFocusChange?.(true)
      }}
      onBlur={() => {
        if (!skipCommit.current) commit()
        skipCommit.current = false
        setFocused(false)
        onFocusChange?.(false)
      }}
      onKeyDown={(e) => {
        const mod = e.ctrlKey || e.metaKey
        if (e.key === 'Enter' && !e.shiftKey && !mod) {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          // Never into the app's Escape (clear selection, close panels).
          e.preventDefault()
          e.stopPropagation()
          skipCommit.current = true
          setDraft(saved)
          e.currentTarget.blur()
        } else if (mod && e.key.toLowerCase() === 's') {
          // Ctrl+S saves the project: send the text first (IPC keeps the order).
          commit()
        }
      }}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onDragStart={stop}
      onContextMenu={stop}
      className={`w-full resize-none rounded border border-white/10 bg-black/50 px-2 py-1.5 text-[11px] leading-snug text-zinc-100 placeholder:text-zinc-500 focus:border-sky-400/60 focus:outline-none ${className}`}
    />
  )
}
