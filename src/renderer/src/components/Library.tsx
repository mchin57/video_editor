import { type JSX } from 'react'
import type { MediaAsset } from '@shared/media'
import { assetAspect, isImageAsset } from '@shared/media'
import { useLibrary, useImportMedia } from '@/hooks/useMedia'
import { latestJob, useEditor } from '@/state/store'
import { activeComp, getFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { makeImageLayer, visualDuration } from '@shared/layers'
import { ClipCard } from '@/components/ClipCard'

/**
 * A library row: the shared `ClipCard` shell (thumbnail + hover preview + meta),
 * made selectable + draggable, with the add-to-timeline / remove action column
 * as its trailing slot. The layout-cell card (FormatMenu) reuses the same
 * `ClipCard` parent without these actions.
 */
function ClipRow({ asset }: { asset: MediaAsset }): JSX.Element {
  const selectedId = useEditor((s) => s.selectedId)
  const select = useEditor((s) => s.select)
  const job = useEditor((s) => latestJob(s.jobs, 'proxy', asset.id))
  const addVideoLayer = useProject((s) => s.addVideoLayer)
  const addAudioClip = useProject((s) => s.addAudioClip)
  const addLayer = useProject((s) => s.addLayer)
  const selectAudio = useUi((s) => s.selectAudio)
  const selectLayer = useUi((s) => s.selectLayer)
  const selectTile = useUi((s) => s.selectTile)
  const onTrack = useProject((s) => activeComp(s)?.audioClips.some((a) => a.mediaId === asset.id) ?? false)
  const removeMedia = useProject((s) => s.removeMedia)

  const isImage = isImageAsset(asset)
  const isAudio = !asset.probe.video && !!asset.probe.audio
  const selected = selectedId === asset.id
  const pct = Math.round((job?.progress ?? 0) * 100)

  // Where to drop a new layer: the playhead, or the end of the current timeline.
  const playhead = (): number => usePlayback.getState().time
  const endOfTimeline = (): number => visualDuration(useProject.getState().project?.layers ?? [])
  const addVideoAt = (startSec: number): void => {
    if (!asset.proxyReady) return
    const id = crypto.randomUUID()
    addVideoLayer(id, asset.id, startSec, asset.probe.durationSec, !!asset.probe.audio, assetAspect(asset))
    // A clip with audio lands as a LINKED pair — select the whole group.
    selectTile(useProject.getState().project, { kind: 'layer', id })
  }
  const addImageAt = (startSec: number): void => {
    if (!asset.proxyReady) return
    const id = crypto.randomUUID()
    addLayer(makeImageLayer(id, asset.id, startSec, startSec + 3, { frame: getFormat().frame, aspect: assetAspect(asset) }))
    selectLayer(id)
  }
  const addBtn = `rounded bg-sky-500/20 px-1 py-0.5 text-center text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/40 whitespace-nowrap ${
    asset.proxyReady ? '' : 'pointer-events-none opacity-30'
  }`

  // The add / remove action column — the Library's variant of the shared card.
  const actions = (
    <>
      {isImage ? (
        <>
          <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); addImageAt(playhead()) }} className={addBtn} title="Add image at the playhead">
            ＋ PH
          </span>
          <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); addImageAt(endOfTimeline()) }} className={addBtn} title="Add image to the end of the timeline">
            ＋ End
          </span>
        </>
      ) : isAudio ? (
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
          className={`rounded px-1 py-0.5 text-center text-[10px] font-semibold whitespace-nowrap transition ${
            onTrack ? 'bg-emerald-500/30 text-emerald-200' : 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/40'
          } ${asset.proxyReady ? '' : 'pointer-events-none opacity-30'}`}
          title="Add to audio track at the playhead"
        >
          ♪ PH
        </span>
      ) : (
        <>
          <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); addVideoAt(playhead()) }} className={addBtn} title="Add clip at the playhead">
            ＋ PH
          </span>
          <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); addVideoAt(endOfTimeline()) }} className={addBtn} title="Add clip to the end of the timeline">
            ＋ End
          </span>
        </>
      )}
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          if (selected) select(null)
          removeMedia(asset.id)
        }}
        className="rounded px-1 text-zinc-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
        title="Remove from this project (kept on disk)"
      >
        ×
      </span>
    </>
  )

  return (
    <ClipCard
      asset={asset}
      selected={selected}
      onClick={() => select(asset.id)}
      draggable={asset.proxyReady}
      onDragStart={(e) => {
        if (!asset.proxyReady) {
          e.preventDefault()
          return
        }
        // Drag onto the timeline to place a layer at the drop position.
        e.dataTransfer.setData('application/x-reel-asset', asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      proxyPct={pct}
      proxyError={job?.status === 'error'}
      trailing={actions}
    />
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
