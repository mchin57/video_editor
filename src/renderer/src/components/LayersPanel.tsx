import { useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { Layer } from '@shared/project'
import { layerLabel, layersAtTime } from '@shared/layers'
import { useLibrary } from '@/hooks/useMedia'
import { activeComp, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { startPointerDrag } from '@/lib/pointerDrag'

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
 * toggles visibility and selects; drag the ⠿ handle to restack.
 *
 * EVERY visible layer restacks, the bottom-most included. This used to pin
 * `layers[0]` as an unmovable "Background", but that pin was UI-only — nothing
 * in the preview, the exporter, the shared model or the schema treats index 0
 * specially — and it cost the common case dearly: a single-clip Reel has exactly
 * one layer, which was therefore "the Background", unmovable, with no way to put
 * anything beneath it.
 */
export function LayersPanel(): JSX.Element {
  const layers = useProject((s) => activeComp(s)?.layers)
  const reorderLayers = useProject((s) => s.reorderLayers)
  const toggleHidden = useProject((s) => s.toggleLayerHidden)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectTile = useUi((s) => s.selectTile)
  // Selecting a row picks the layer's whole link group, like the timeline does.
  const selectLayer = (id: string): void =>
    selectTile(useProject.getState().project, { kind: 'layer', id })
  const time = usePlayback((s) => s.time)
  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const stack = layers ?? []

  // Visible layers (those whose span covers the playhead), front → back. Every
  // one of them is draggable.
  const visibleFrontToBack = useMemo(() => layersAtTime(stack, time).slice().reverse(), [stack, time])
  const draggableIds = visibleFrontToBack.map((l) => l.id)

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
    startPointerDrag(
      (ev) => {
        const idx = clamp(Math.floor((ev.clientY - listTop()) / ROW_H), 0, base.length - 1)
        const without = base.filter((x) => x !== id)
        without.splice(idx, 0, id)
        orderRef.current = without
        setDrag({ id, order: without })
      },
      () => {
        const finalOrder = orderRef.current
        // The list IS the whole visible set now, so it goes to the store as-is;
        // `applyVisibleOrder` permutes those layers within their own slots and
        // leaves everything off-playhead untouched.
        if (finalOrder) reorderLayers(finalOrder)
        setOrder(null)
      }
    )
  }

  const label = (l: Layer): string => {
    if (l.content.kind === 'video' || l.content.kind === 'image') {
      const name = assetById.get(l.content.mediaId)?.fileName
      if (name) return name
    }
    return layerLabel(l)
  }

  const renderRow = (l: Layer): JSX.Element => {
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
        <span
          onPointerDown={(e) => startDrag(e, l.id)}
          title="Drag to reorder"
          className="w-3.5 shrink-0 cursor-grab text-center text-zinc-500 hover:text-zinc-200"
        >
          ⠿
        </span>
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
          <div ref={listRef}>{liveRows.map((l) => renderRow(l))}</div>
        )}
      </div>
    </div>
  )
}
