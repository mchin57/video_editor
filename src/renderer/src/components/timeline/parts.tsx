/** Timeline ▸ small presentational parts: a tile's thumbnail, its freeze overlays, its pose badge and a toolbar button. */

import { useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { isWorkoutAsset, type MediaAsset } from '@shared/media'
import type { VideoContent } from '@shared/project'
import type { FreezeSpan } from '@shared/layers'
import { thumbUrl, workoutThumbUrl } from '@/ipc/client'
import { usePoseData } from '@/hooks/usePose'

/**
 * A layer tile's thumbnail. Hidden while it can't load — but only for the asset
 * data it failed for: the next library refresh (new object) tries again, so a
 * tile drawn a moment before its thumb existed doesn't stay blank for good.
 */
export function TileThumb({ asset }: { asset: MediaAsset }): JSX.Element | null {
  const [failedFor, setFailedFor] = useState<MediaAsset | null>(null)
  if (failedFor === asset) return null
  return (
    <img
      src={isWorkoutAsset(asset) ? workoutThumbUrl(asset) : thumbUrl(asset)}
      alt=""
      onError={() => setFailedFor(asset)}
      className="pointer-events-none h-full w-6 shrink-0 rounded-sm object-cover opacity-80"
    />
  )
}
export function ToolbarButton({
  onClick,
  disabled,
  title,
  children
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

/**
 * A freeze hold drawn on its clip tile: a translucent blue box over the span the
 * frame is held. Pressing the box selects and moves the clip like the rest of the
 * tile, and a click (no drag) picks the freeze so Delete removes it; dragging its
 * right edge sets the hold. When the hold ends the clip, that handle sits just
 * inside the clip's own end handle so both stay reachable. On a linked tile the
 * box is display-only: re-timing one member would desync the group (the
 * Inspector's freeze controls lock the same way).
 */
export function FreezeOverlay({
  layerId,
  span,
  left,
  width,
  atClipEnd,
  picked,
  linked,
  onBodyDown,
  onEdgeDown
}: {
  layerId: string
  span: FreezeSpan
  left: number
  width: number
  atClipEnd: boolean
  picked: boolean
  linked: boolean
  onBodyDown: (e: ReactPointerEvent) => void
  onEdgeDown: (e: ReactPointerEvent) => void
}): JSX.Element {
  const hold = `${span.holdSec.toFixed(1)}s`
  return (
    <div
      data-testid={`freeze-${layerId}-${span.index}`}
      data-picked={picked ? 'true' : undefined}
      onPointerDown={linked ? undefined : onBodyDown}
      // A linked box takes no pointer events, so it never shows a tooltip.
      title={
        linked
          ? undefined
          : `Freeze ${hold}: click to select (Delete removes it), drag the right edge to change the hold`
      }
      className={`absolute top-0 h-full border-x ${
        picked ? 'border-sky-100 bg-sky-400/55 ring-2 ring-inset ring-sky-100' : 'border-sky-300/70 bg-sky-500/35'
      } ${linked ? 'pointer-events-none' : ''}`}
      style={{ left, width: Math.max(3, width) }}
    >
      <span className="pointer-events-none absolute bottom-0 left-0.5 max-w-full truncate text-[8px] font-bold leading-tight text-sky-50">
        ❄ {hold}
      </span>
      {!linked && (
        <div
          data-testid={`freeze-edge-${layerId}-${span.index}`}
          onPointerDown={onEdgeDown}
          className="absolute top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/50"
          style={{ right: atClipEnd ? 8 : 0 }}
        />
      )}
    </div>
  )
}

/**
 * A clip tile's pose badge: shown while the clip draws a skeleton — overlay on,
 * someone picked, AND the detection there to draw from (a Save As or relink
 * can leave settings with no data; the badge mustn't claim an overlay then).
 */
export function PoseBadge({ layerId, content }: { layerId: string; content: VideoContent }): JSX.Element | null {
  const pose = content.pose
  const active = !!pose?.show && pose.people.length > 0
  const data = usePoseData(content.mediaId, active)
  if (!active || !data) return null
  const n = pose!.people.length
  return (
    <span
      data-testid={`tile-pose-${layerId}`}
      className="shrink-0 rounded bg-yellow-400/80 px-1 text-[8px] font-bold leading-tight text-yellow-950"
      title={`Pose overlay: ${n === 1 ? '1 person' : `${n} people`}`}
    >
      🦴
    </span>
  )
}
