import { useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { CropRect, Layer, VideoContent } from '@shared/project'
import type { MediaAsset, VideoStreamInfo } from '@shared/media'
import { useLibrary } from '@/hooks/useMedia'
import { activeComp, projectFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { clampCrop, defaultCrop, isFullFrame, resizeCrop } from '@/lib/crop'
import { startPointerDrag } from '@/lib/pointerDrag'
import { thumbUrl } from '@/ipc/client'

/**
 * Modal to crop a video layer to the PROJECT'S aspect ratio (9:16 for a Reel,
 * 16:9 for Landscape, …). Shows the source frame (thumbnail) at its native
 * aspect with a draggable / corner-resizable crop box locked to that ratio.
 * Edits are local until Save.
 */
export function CropEditor(): JSX.Element | null {
  const cropEditing = useUi((s) => s.cropEditing)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const layer = useProject((s) => activeComp(s)?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const content = layer && layer.content.kind === 'video' ? layer.content : null
  const { data: assets = [] } = useLibrary()
  const asset = content ? assets.find((a) => a.id === content.mediaId) : undefined
  const v = asset?.probe.video

  if (!cropEditing || !layer || !content || !asset || !v) return null
  // Keyed per layer so the box is seeded fresh (from the layer's crop, or a
  // centred crop at the project aspect) every time the editor opens.
  return <CropModal key={layer.id} layer={layer} content={content} asset={asset} v={v} />
}

function CropModal({
  layer,
  content,
  asset,
  v
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset
  v: VideoStreamInfo
}): JSX.Element {
  const setCropEditing = useUi((s) => s.setCropEditing)
  const setVideoCrop = useProject((s) => s.setVideoCrop)
  const format = useProject(projectFormat)
  const aspect = format.width / format.height

  const srcW = v.displayWidth
  const srcH = v.displayHeight
  const [box, setBox] = useState<CropRect>(() => content.crop ?? defaultCrop(srcW, srcH, aspect))
  const [rendered, setRendered] = useState({ w: 0, h: 0 })
  const frameRef = useRef<HTMLDivElement>(null)

  const scale = useMemo(() => (rendered.w > 0 ? rendered.w / srcW : 0), [rendered.w, srcW])

  const move = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const start = box
    startPointerDrag((ev) => {
      const dx = (ev.clientX - startX) / scale
      const dy = (ev.clientY - startY) / scale
      setBox(clampCrop({ ...start, x: start.x + dx, y: start.y + dy }, srcW, srcH))
    })
  }

  const resize = (e: ReactPointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    startPointerDrag((ev) => {
      const rect = frameRef.current?.getBoundingClientRect()
      if (!rect) return
      const newW = (ev.clientX - rect.left) / scale - box.x
      setBox(resizeCrop(box, newW, srcW, srcH, aspect))
    })
  }

  const save = (): void => {
    setVideoCrop(layer.id, isFullFrame(box, srcW, srcH) ? null : box, srcW / srcH)
    setCropEditing(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-8">
      <div className="text-sm text-zinc-300">Crop to {format.ratioLabel} — drag to move, drag the corner to resize</div>

      <div ref={frameRef} className="relative" style={{ width: rendered.w || 'auto', height: rendered.h || 'auto' }}>
        <img
          src={thumbUrl(asset)}
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
          onClick={() => setBox(defaultCrop(srcW, srcH, aspect))}
          className="rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Reset
        </button>
        <button
          onClick={() => {
            setVideoCrop(layer.id, null, srcW / srcH)
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
