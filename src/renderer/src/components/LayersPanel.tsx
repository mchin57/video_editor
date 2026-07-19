import { useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { Layer } from '@shared/project'
import { layerLabel, layersAtTime } from '@shared/layers'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'

const ROW_H = 30 // px — must match the row height below for drag math
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

const kindIcon = (l: Layer): string =>
  l.content.kind === 'video' ? '🎬' : l.content.kind === 'image' ? '🖼' : l.content.kind === 'layout' ? '▦' : '🅣'

/** Drag state: the layer being dragged and the live front→back order it implies. */
interface Drag {
  id: string
  order: string[]
}

/**
 * The Layers menu. Lists the layers on screen at the playhead, front (top) →
 * back (bottom), so it follows the timeline: a layer drops out of the list the
 * moment the playhead leaves its span, and the panel resizes to fit. Each row
 * toggles visibility and selects; drag the ⠿ handle to restack. The bottom-most
 * layer of the whole stack is the Background and stays pinned at the bottom.
 */
export function LayersPanel(): JSX.Element {
  const layers = useProject((s) => s.project?.layers)
  const reorderLayers = useProject((s) => s.reorderLayers)
  const toggleHidden = useProject((s) => s.toggleLayerHidden)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectLayer = useUi((s) => s.selectLayer)
  const time = usePlayback((s) => s.time)
  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const stack = layers ?? []
  const backgroundId = stack.length > 0 ? stack[0].id : null

  // Visible layers (those whose span covers the playhead), front → back.
  const visibleFrontToBack = useMemo(() => layersAtTime(stack, time).slice().reverse(), [stack, time])
  const bgVisible = visibleFrontToBack.find((l) => backgroundId && l.id === backgroundId) ?? null
  // The draggable rows are the visible layers minus the (pinned) background.
  const draggable = visibleFrontToBack.filter((l) => l.id !== bgVisible?.id)
  const draggableIds = draggable.map((l) => l.id)

  const [drag, setDrag] = useState<Drag | null>(null)
  const orderRef = useRef<string[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const setOrder = (order: string[] | null): void => {
    orderRef.current = order
    setDrag(order ? { id: drag?.id ?? '', order } : null)
  }

  const byId = useMemo(() => new Map(stack.map((l) => [l.id, l])), [stack])
  const liveOrder = drag ? drag.order : draggableIds
  const liveRows = liveOrder.map((id) => byId.get(id)).filter((l): l is Layer => l != null)

  const startDrag = (e: ReactPointerEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const base = draggableIds.slice()
    orderRef.current = base
    setDrag({ id, order: base })
    const listTop = (): number => listRef.current?.getBoundingClientRect().top ?? 0
    const onMove = (ev: PointerEvent): void => {
      const idx = clamp(Math.floor((ev.clientY - listTop()) / ROW_H), 0, base.length - 1)
      const without = base.filter((x) => x !== id)
      without.splice(idx, 0, id)
      orderRef.current = without
      setDrag({ id, order: without })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const finalOrder = orderRef.current
      if (finalOrder) {
        const fullFrontToBack = bgVisible ? [...finalOrder, bgVisible.id] : finalOrder
        reorderLayers(fullFrontToBack)
      }
      setOrder(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const label = (l: Layer): string => {
    if (l.content.kind === 'video' || l.content.kind === 'image') {
      const name = assetById.get(l.content.mediaId)?.fileName
      if (name) return name
    }
    return layerLabel(l)
  }

  const renderRow = (l: Layer, background: boolean): JSX.Element => {
    const selected = l.id === selectedLayerId
    return (
      <div
        key={l.id}
        onPointerDown={() => selectLayer(l.id)}
        style={{ height: ROW_H }}
        className={`group flex items-center gap-1.5 rounded px-1.5 text-xs ${
          selected ? 'bg-sky-500/20 text-zinc-100' : 'text-zinc-300 hover:bg-white/5'
        } ${drag?.id === l.id ? 'opacity-60 ring-1 ring-sky-400/60' : ''}`}
      >
        {background ? (
          <span className="w-3.5 shrink-0 text-center text-[10px] text-zinc-600" title="Background — pinned">
            ▦
          </span>
        ) : (
          <span
            onPointerDown={(e) => startDrag(e, l.id)}
            title="Drag to reorder"
            className="w-3.5 shrink-0 cursor-grab text-center text-zinc-500 hover:text-zinc-200"
          >
            ⠿
          </span>
        )}
        <input
          type="checkbox"
          checked={!l.hidden}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={() => toggleHidden(l.id)}
          title={l.hidden ? 'Show layer' : 'Hide layer'}
          className="shrink-0 accent-sky-400"
        />
        <span className="shrink-0 text-[11px]">{kindIcon(l)}</span>
        <span className="min-w-0 flex-1 truncate" title={label(l)}>
          {label(l)}
        </span>
        {background && <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">bg</span>}
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-white/10">
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>Layers</span>
        <span className="text-[10px] font-normal normal-case text-zinc-600">front ↑ · back ↓</span>
      </div>
      <div className="max-h-[40vh] overflow-y-auto px-1.5 pb-2">
        {visibleFrontToBack.length === 0 ? (
          <div className="px-1.5 py-2 text-[11px] text-zinc-600">No layers at the playhead.</div>
        ) : (
          <>
            <div ref={listRef}>{liveRows.map((l) => renderRow(l, false))}</div>
            {bgVisible && renderRow(bgVisible, true)}
          </>
        )}
      </div>
    </div>
  )
}
