import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { NormCrop } from '@shared/project'
import { Popout } from './Popout'
import { btnCls as btn, toggleCls as toggle } from './ui'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { startPointerDrag } from '@/lib/pointerDrag'
import { imageUrl } from '@/ipc/client'

const FULL: NormCrop = { x: 0, y: 0, w: 1, h: 1 }
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const isFull = (c: NormCrop): boolean => c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999

/**
 * Floating editor for an image layer: a free-aspect crop box drawn over the
 * (un-rotated) source, plus 90° rotate, flip, and opacity. Crop is stored in
 * 0..1 source fractions — applied before rotation in both preview and export.
 */
export function ImageEditPopout(): JSX.Element | null {
  const open = useUi((s) => s.imageEditOpen)
  const setOpen = useUi((s) => s.setImageEditOpen)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const layer = useProject((s) => activeComp(s)?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const updateContent = useProject((s) => s.updateLayerContent)
  const content = layer && layer.content.kind === 'image' ? layer.content : null
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<NormCrop>(content?.crop ?? FULL)

  // Re-sync when switching to a different image layer.
  useEffect(() => {
    setBox(content?.crop ?? FULL)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayerId])

  if (!open) return null
  if (!content || !layer) {
    return (
      <Popout title="Edit image" onClose={() => setOpen(false)} width={320}>
        <p className="text-xs text-zinc-500">Select an image layer to edit it.</p>
      </Popout>
    )
  }

  const id = layer.id
  const q = (((content.rotateQuarters ?? 0) % 4) + 4) % 4
  const commitCrop = (c: NormCrop): void => updateContent(id, { crop: isFull(c) ? null : c })

  const commitOnUp = (): void => void setBox((b) => (commitCrop(b), b))

  const move = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const sx = e.clientX
    const sy = e.clientY
    const start = box
    startPointerDrag((ev) => {
      const nx = clamp01(start.x + (ev.clientX - sx) / rect.width)
      const ny = clamp01(start.y + (ev.clientY - sy) / rect.height)
      setBox({ ...start, x: Math.min(nx, 1 - start.w), y: Math.min(ny, 1 - start.h) })
    }, commitOnUp)
  }

  const resize = (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    startPointerDrag((ev) => {
      const w = clamp01((ev.clientX - rect.left) / rect.width - box.x)
      const h = clamp01((ev.clientY - rect.top) / rect.height - box.y)
      setBox({ ...box, w: Math.max(0.05, Math.min(w, 1 - box.x)), h: Math.max(0.05, Math.min(h, 1 - box.y)) })
    }, commitOnUp)
  }

  return (
    <Popout title="Edit image" onClose={() => setOpen(false)} width={320}>
      <p className="mb-2 text-[11px] text-zinc-500">Drag to move the crop, drag the corner to resize.</p>
      <div ref={wrapRef} className="relative mb-3 select-none">
        <img src={imageUrl(content.mediaId)} alt="" draggable={false} className="block w-full rounded" />
        <div className="pointer-events-none absolute inset-0 bg-black/50" />
        <div
          onPointerDown={move}
          className="absolute cursor-move ring-2 ring-sky-400"
          style={{
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.w * 100}%`,
            height: `${box.h * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)'
          }}
        >
          <div
            onPointerDown={resize}
            className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm bg-sky-400"
          />
        </div>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <button className={btn} onClick={() => updateContent(id, { rotateQuarters: (q + 3) % 4 })}>
          ⟲ Rotate left
        </button>
        <button className={btn} onClick={() => updateContent(id, { rotateQuarters: (q + 1) % 4 })}>
          ⟳ Rotate right
        </button>
        <button className={toggle(!!content.flipH)} onClick={() => updateContent(id, { flipH: !content.flipH })}>
          ⇋ Flip H
        </button>
        <button className={toggle(!!content.flipV)} onClick={() => updateContent(id, { flipV: !content.flipV })}>
          ⇅ Flip V
        </button>
      </div>

      <label className="mb-1 block">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
          Opacity · {Math.round(content.opacity * 100)}%
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={content.opacity}
          onChange={(e) => updateContent(id, { opacity: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </label>

      <button
        className="mt-2 w-full rounded bg-white/5 px-2 py-1.5 text-xs text-zinc-400 hover:bg-white/10"
        onClick={() => {
          setBox(FULL)
          updateContent(id, { crop: null, rotateQuarters: 0, flipH: false, flipV: false })
        }}
      >
        Reset crop & transforms
      </button>
    </Popout>
  )
}
