import { useState, type JSX } from 'react'
import type { MediaAsset } from '@shared/media'
import { useLibrary, useImportMedia, useRemoveMedia } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { formatDuration } from '@/lib/format'
import { thumbUrl } from '@/ipc/client'

/** First-frame thumbnail with a ▶ fallback until/if the jpg is available. */
function ClipThumb({ asset }: { asset: MediaAsset }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="text-base text-zinc-600">▶</span>
  return (
    <img
      src={thumbUrl(asset.id)}
      alt=""
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  )
}

function ClipBadges({ asset }: { asset: MediaAsset }): JSX.Element | null {
  const v = asset.probe.video
  if (!v) return null
  return (
    <div className="flex flex-wrap gap-1">
      {v.isHdr && (
        <span className="rounded bg-fuchsia-500/15 px-1 text-[9px] font-medium text-fuchsia-300">HDR</span>
      )}
      {v.isVfr && (
        <span className="rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-300">VFR</span>
      )}
      {v.rotationDeg !== 0 && (
        <span className="rounded bg-sky-500/15 px-1 text-[9px] font-medium text-sky-300">
          ⟳{v.rotationDeg}°
        </span>
      )}
    </div>
  )
}

function ClipRow({ asset }: { asset: MediaAsset }): JSX.Element {
  const selectedId = useEditor((s) => s.selectedId)
  const select = useEditor((s) => s.select)
  const job = useEditor((s) => (asset.id in s.proxyJobs ? s.proxyJobs[asset.id] : undefined))
  const addClip = useProject((s) => s.addClip)
  const addAudioClip = useProject((s) => s.addAudioClip)
  const selectAudio = useUi((s) => s.selectAudio)
  const onTrack = useProject((s) => s.project?.audioClips.some((a) => a.mediaId === asset.id) ?? false)
  const remove = useRemoveMedia()

  const v = asset.probe.video
  const isAudio = !v && !!asset.probe.audio
  const selected = selectedId === asset.id
  const pct = Math.round((job?.progress ?? 0) * 100)

  return (
    <button
      onClick={() => select(asset.id)}
      className={`group flex w-full gap-2 rounded-lg border p-2 text-left transition ${
        selected
          ? 'border-sky-400/50 bg-sky-400/10'
          : 'border-white/5 bg-white/[0.02] hover:bg-white/5'
      }`}
    >
      {/* 9:16 thumbnail (or a music glyph for audio) */}
      <div className="relative flex h-16 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-black/60 text-zinc-600">
        {isAudio ? <span className="text-base text-sky-300">♪</span> : <ClipThumb asset={asset} />}
        {!asset.proxyReady && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-700">
            <div className="h-full bg-sky-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-200" title={asset.fileName}>
          {asset.fileName}
        </div>
        <div className="mt-0.5 text-[10px] text-zinc-500">
          {v ? `${v.displayWidth}×${v.displayHeight}` : 'no video'} · {formatDuration(asset.probe.durationSec)}
        </div>
        <div className="mt-1">
          {asset.proxyReady ? (
            <ClipBadges asset={asset} />
          ) : job?.status === 'error' ? (
            <span className="text-[10px] text-rose-400">proxy failed</span>
          ) : (
            <span className="text-[10px] text-sky-400/80">generating preview… {pct}%</span>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center gap-1">
        {isAudio ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              if (!asset.proxyReady) return
              const id = crypto.randomUUID()
              addAudioClip({
                id,
                mediaId: asset.id,
                startSec: usePlayback.getState().time,
                inSec: 0,
                outSec: asset.probe.durationSec,
                gainDb: 0,
                fadeInSec: 0,
                fadeOutSec: 0,
                duck: false,
                kind: 'audio'
              })
              selectAudio(id)
            }}
            className={`rounded px-1.5 text-xs font-semibold transition ${
              onTrack
                ? 'bg-emerald-500/30 text-emerald-200'
                : 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/40'
            } ${asset.proxyReady ? '' : 'pointer-events-none opacity-30'}`}
            title="Add to audio track at the playhead"
          >
            ♪
          </span>
        ) : (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              if (asset.proxyReady) addClip(asset.id, asset.probe.durationSec, !!asset.probe.audio)
            }}
            className={`rounded bg-sky-500/20 px-1.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/40 ${
              asset.proxyReady ? '' : 'pointer-events-none opacity-30'
            }`}
            title="Add to timeline"
          >
            ＋
          </span>
        )}
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            if (selected) select(null)
            remove.mutate(asset.id)
          }}
          className="rounded px-1 text-zinc-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
          title="Remove from library"
        >
          ×
        </span>
      </div>
    </button>
  )
}

export function Library(): JSX.Element {
  const { data: assets = [], isLoading } = useLibrary()
  const importMedia = useImportMedia()

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Library</span>
        <button
          onClick={() => importMedia.mutate(undefined)}
          disabled={importMedia.isPending}
          className="rounded bg-sky-500/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        >
          {importMedia.isPending ? 'Importing…' : '+ Import'}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {isLoading && <p className="p-2 text-xs text-zinc-600">Loading…</p>}
        {!isLoading && assets.length === 0 && (
          <p className="p-2 text-xs text-zinc-600">
            Drag iPhone clips here, or click <span className="text-zinc-400">+ Import</span>.
          </p>
        )}
        {assets.map((asset) => (
          <ClipRow key={asset.id} asset={asset} />
        ))}
      </div>
    </div>
  )
}
