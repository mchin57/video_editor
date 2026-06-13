import type { JSX } from 'react'
import { LOGICAL, SAFE_ZONES } from '@/lib/coords'
import { proxyUrl, thumbUrl } from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'

const pct = (value: number, total: number): string => `${(value / total) * 100}%`

/** 9:16 preview stage: proxy video (when ready) under the Instagram safe-zone guides. */
export function PreviewStage(): JSX.Element {
  const selectedId = useEditor((s) => s.selectedId)
  const { data: assets = [] } = useLibrary()
  const asset = assets.find((a) => a.id === selectedId) ?? null
  const job = useEditor((s) => (selectedId && selectedId in s.proxyJobs ? s.proxyJobs[selectedId] : undefined))

  return (
    <div className="relative aspect-[9/16] h-full overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10">
      {asset?.proxyReady ? (
        <video
          key={asset.id}
          src={proxyUrl(asset.id)}
          controls
          className="absolute inset-0 h-full w-full bg-black object-contain"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-600">
          {asset ? (
            <>
              <img
                src={thumbUrl(asset.id)}
                alt=""
                onError={(e) => (e.currentTarget.style.display = 'none')}
                className="absolute inset-0 h-full w-full object-contain opacity-40"
              />
              <span className="z-10">Generating preview…</span>
              <span className="z-10 text-xs text-sky-400/80">
                {Math.round((job?.progress ?? 0) * 100)}%
              </span>
            </>
          ) : (
            'Import a clip to begin'
          )}
        </div>
      )}

      {/* Hook zone (first 3 seconds) — top band */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[6%] items-center justify-center border-b border-amber-400/30 bg-amber-400/10 text-[10px] uppercase tracking-wide text-amber-300/80">
        Hook zone · first 3s
      </div>

      {/* Bottom safe zone */}
      <div
        className="pointer-events-none absolute left-0 w-full border-t border-rose-400/40 bg-rose-500/10"
        style={{ top: pct(SAFE_ZONES.bottom.y, LOGICAL.height), height: pct(SAFE_ZONES.bottom.h, LOGICAL.height) }}
      />
      {/* Right action rail */}
      <div
        className="pointer-events-none absolute top-0 h-full border-l border-rose-400/40 bg-rose-500/10"
        style={{ left: pct(SAFE_ZONES.rightRail.x, LOGICAL.width), width: pct(SAFE_ZONES.rightRail.w, LOGICAL.width) }}
      />

      <div className="pointer-events-none absolute left-2 top-2 text-[10px] uppercase tracking-wide text-zinc-500">
        {LOGICAL.width} × {LOGICAL.height}
      </div>
    </div>
  )
}
