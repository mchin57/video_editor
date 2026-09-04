import { useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { startPointerDrag } from '@/lib/pointerDrag'

/**
 * A lightweight floating, draggable panel (not a full-screen modal) — for tools
 * that the user wants visible alongside the preview, like the clip stills gallery
 * and the image editor. Drag the header to move it; ✕ or `onClose` closes it.
 */
export function Popout({
  title,
  onClose,
  width = 320,
  initial,
  children
}: {
  title: string
  onClose: () => void
  width?: number
  initial?: { x: number; y: number }
  children: ReactNode
}): JSX.Element {
  const [pos, setPos] = useState(() => initial ?? { x: window.innerWidth - width - 48, y: 96 })

  // The grab offset lives in the drag's own closure — `startPointerDrag` tears
  // the listeners down itself (pointercancel included), so there is no
  // is-a-drag-live flag left for a stale move to consult.
  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const dx = e.clientX - pos.x
    const dy = e.clientY - pos.y
    startPointerDrag((ev) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))
      })
    })
  }

  return (
    <div
      style={{ left: pos.x, top: pos.y, width }}
      className="fixed z-[60] flex max-h-[80vh] flex-col overflow-hidden rounded-lg border border-white/15 bg-zinc-900/95 shadow-2xl backdrop-blur"
    >
      <div
        onPointerDown={onDown}
        className="flex cursor-move items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2"
      >
        <span className="text-xs font-semibold text-zinc-200">{title}</span>
        <button
          onClick={onClose}
          className="rounded px-1.5 text-sm text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  )
}
