/** Timeline ▸ the hovered media tile's clip description, floating above it and editable in place. */

import { useRef, type JSX } from 'react'
import { type MediaAsset } from '@shared/media'
import { createPortal } from 'react-dom'
import { useHoverGuard } from '@/hooks/useHoverIntent'
import type { HoverIntent } from '@/lib/hoverIntent'
import { DescriptionBox } from '@/components/DescriptionBox'

/** Where a hovered media tile (video, image, audio) is, for its description box. */
export interface TileDescriptionAt {
  mediaId: string
  /** The tile itself (a member of the hover group) and where it was on entering. */
  el: HTMLElement
  rect: DOMRect
  /** Cursor x on entering: the box centres there, so moving straight up reaches it. */
  x: number
}
/**
 * The hovered media tile's clip description, floating just above the tile
 * (below it when there's no room) and editable in place (`DescriptionBox`). Tile,
 * box and the bridge over the gap form one hover group (`HoverIntent`), so the
 * cursor can travel from the tile up into the box; typing pins it open.
 * Portaled: the timeline's scroll area would clip it.
 */
export function TileDescription({
  asset,
  at,
  intent
}: {
  asset: MediaAsset
  at: TileDescriptionAt
  intent: HoverIntent<TileDescriptionAt>
}): JSX.Element {
  const W = 260
  const GAP = 6
  const ROOM = 120 // about the box's height
  const left = Math.max(8, Math.min(at.x - W / 2, window.innerWidth - W - 8))
  const below = at.rect.top - GAP - ROOM < 8
  const box = below ? { top: at.rect.bottom + GAP } : { bottom: window.innerHeight - at.rect.top + GAP }
  // The bridge overlaps the tile and the box by a pixel so the crossing never reads as a leave.
  const bridgeTop = below ? at.rect.bottom - 1 : at.rect.top - GAP - 1
  const group = { onMouseEnter: () => intent.enter(), onMouseLeave: () => intent.leave() }
  const boxRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<HTMLDivElement>(null)
  useHoverGuard({ enter: () => intent.enter(), leave: () => intent.leave() }, () => [
    at.el,
    boxRef.current,
    bridgeRef.current
  ])
  return createPortal(
    <>
      <div
        ref={bridgeRef}
        data-description-panel
        style={{ position: 'fixed', left, width: W, top: bridgeTop, height: GAP + 2 }}
        className="z-[499]"
        {...group}
      />
      <div
        ref={boxRef}
        data-testid="timeline-description"
        data-description-panel
        style={{ position: 'fixed', left, width: W, ...box }}
        className="z-[500] rounded-lg border border-white/15 bg-zinc-900/95 p-2 shadow-2xl"
        {...group}
      >
        <div className="mb-1 truncate text-[10px] font-semibold text-zinc-400" title={asset.fileName}>
          {asset.fileName}
        </div>
        <DescriptionBox
          asset={asset}
          rows={3}
          onFocusChange={(on) => intent.pin(on, !!boxRef.current?.matches(':hover'))}
        />
      </div>
    </>,
    document.body
  )
}
