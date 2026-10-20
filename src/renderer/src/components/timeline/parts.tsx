/** Timeline ▸ small presentational parts: a tile's thumbnail and a toolbar button. */

import { useState, type JSX } from 'react'
import { type MediaAsset } from '@shared/media'
import { thumbUrl } from '@/ipc/client'

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
