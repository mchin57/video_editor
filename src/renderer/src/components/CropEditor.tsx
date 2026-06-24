import { useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { CropRect } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { clampCrop, defaultCrop, isFullFrame, resizeCrop } from '@/lib/crop'
import { thumbUrl } from '@/ipc/client'

/**
 * Modal to set a video layer's 9:16 crop. Shows the source frame (thumbnail) at
 * its native aspect with a draggable / corner-resizable crop box locked to 9:16.
 * Edits are local until Save.
 */
export function CropEditor(): JSX.Element | null {
  const cropEditing = useUi((s) => s.cropEditing)
  const setCropEditing = useUi((s) => s.setCropEditing)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const layer = useProject((s) => s.project?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const updateLayerContent = useProject((s) => s.updateLayerContent)
  const content = layer && layer.content.kind === 'video' ? layer.content : null
  const { data: assets = [] } = useLibrary()
  const asset = content ? assets.find((a) => a.id === content.mediaId) : undefined
  const v = asset?.probe.video

  const srcW = v?.displayWidth ?? 1080
  const srcH = v?.displayHeight ?? 1920
  const [box, setBox] = useState<CropRect>(() => content?.crop ?? defaultCrop(srcW, srcH))
  const [rendered, setRendered] = useState({ w: 0, h: 0 })
  const frameRef = useRef<HTMLDivElement>(null)

  const scale = useMemo(() => (rendered.w > 0 ? rendered.w / srcW : 0), [rendered.w, srcW])

  if (!cropEditing || !layer || !content || !v) return null

  const move = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const start = box
    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startX) / scale
      const dy = (ev.clientY - startY) / scale
      setBox(clampCrop({ ...start, x: start.x + dx, y: start.y + dy }, srcW, srcH))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const resize = (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const onMove = (ev: PointerEvent): void => {
      const rect = frameRef.current?.getBoundingClientRect()
      if (!rect) return
      const newW = (ev.clientX - rect.left) / scale - box.x
      setBox(resizeCrop(box, newW, srcW, srcH))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const save = (): void => {
    updateLayerContent(layer.id, { crop: isFullFrame(box, srcW, srcH) ? null : box })
    setCropEditing(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-8">
      <div className="text-sm text-zinc-300">
        Crop to 9:16 — drag to move, drag the corner to resize
      </div>

      <div
        ref={frameRef}
        className="relative"
        style={{ width: rendered.w || 'auto', height: rendered.h || 'auto' }}
      >
        <img
          src={thumbUrl(asset!.id)}
          alt=""
          onLoad={(e) => setRendered({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight })}
          className="block max-h-[70vh] max-w-[80vw] select-none rounded"
          draggable={false}
        />
        {scale > 0 && (
          <>
            {/* dim outside the crop */}
            <div className="pointer-events-none absolute inset-0 bg-black/55" />
            <div
              onPointerDown={move}
              className="absolute cursor-move ring-2 ring-sky-400"
              style={{
                left: box.x * scale,
                top: box.y * scale,
                width: box.w * scale,
                height: box.h * scale,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)'
              }}
            >
              <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-40">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="border border-white/30" />
                ))}
              </div>
              <div
                onPointerDown={resize}
                className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm bg-sky-400"
              />
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setBox(defaultCrop(srcW, srcH))}
          className="rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Reset
        </button>
        <button
          onClick={() => {
            updateLayerContent(layer.id, { crop: null })
            setCropEditing(false)
          }}
          className="rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Remove crop
        </button>
        <button
          onClick={() => setCropEditing(false)}
          className="rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Cancel
        </button>
        <button
          onClick={save}
          className="rounded bg-sky-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400"
        >
          Save crop
        </button>
      </div>
    </div>
  )
}
