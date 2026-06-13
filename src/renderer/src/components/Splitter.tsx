import type { JSX, PointerEvent as ReactPointerEvent } from 'react'

/**
 * A thin draggable divider. Reports incremental pointer movement (px) along its
 * axis via onDrag; the parent applies it to a panel size (with clamping).
 */
export function Splitter({
  orientation,
  onDrag
}: {
  orientation: 'vertical' | 'horizontal'
  onDrag: (deltaPx: number) => void
}): JSX.Element {
  const start = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const axis = (ev: { clientX: number; clientY: number }): number =>
      orientation === 'vertical' ? ev.clientX : ev.clientY
    let last = axis(e)
    const onMove = (ev: PointerEvent): void => {
      const cur = axis(ev)
      onDrag(cur - last)
      last = cur
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      onPointerDown={start}
      className={
        orientation === 'vertical'
          ? 'z-10 w-1 shrink-0 cursor-col-resize bg-white/5 transition-colors hover:bg-sky-400/50'
          : 'z-10 h-1 shrink-0 cursor-row-resize bg-white/5 transition-colors hover:bg-sky-400/50'
      }
    />
  )
}
