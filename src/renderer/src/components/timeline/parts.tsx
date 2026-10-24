/** Timeline ▸ small presentational parts: a tile's thumbnail, its pose badge and a toolbar button. */

import { useState, type JSX } from 'react'
import { type MediaAsset } from '@shared/media'
import type { VideoContent } from '@shared/project'
import { thumbUrl } from '@/ipc/client'
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
      src={thumbUrl(asset)}
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
