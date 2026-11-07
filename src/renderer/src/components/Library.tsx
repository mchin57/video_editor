import { useState, type JSX } from 'react'
import type { MediaAsset } from '@shared/media'
import { assetKind, isAudioAsset, isImageAsset, isUnknownClip, isWorkoutAsset } from '@shared/media'
import { sharedKindOf } from '@shared/sharedLibrary'
import {
  useLibrary,
  useImportMedia,
  useMergeClips,
  useQuickCut,
  useRenameMedia,
  useRepairMedia
} from '@/hooks/useMedia'
import { MergeClipsDialog } from '@/components/MergeClipsDialog'
import { revealFile } from '@/ipc/client'
import { RenameMediaDialog } from '@/components/RenameMediaDialog'
import { QuickCutDialog } from '@/components/QuickCutDialog'
import { latestJob, useEditor } from '@/state/store'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { visualDuration } from '@shared/layers'
import { ClipCard } from '@/components/ClipCard'
import { MENU_SEPARATOR, btnCls, disabledCls, useContextMenu, type ContextMenuEntry } from '@/components/ui'
import { placeWorkout } from '@/lib/workout'
import { placeAsset } from '@/lib/placeAsset'

/**
 * A library row: the shared `ClipCard` shell (thumbnail + hover preview + meta),
 * made selectable + draggable, with the add-to-timeline / remove action column
 * as its trailing slot. The layout-cell card (FormatMenu) reuses the same
 * `ClipCard` parent without these actions.
 */
function ClipRow({ asset, mergeable }: { asset: MediaAsset; mergeable: MediaAsset[] }): JSX.Element {
  const selectedId = useEditor((s) => s.selectedId)
  const select = useEditor((s) => s.select)
  const job = useEditor((s) => latestJob(s.jobs, 'proxy', asset.id))
  const onTrack = useProject((s) => activeComp(s)?.audioClips.some((a) => a.mediaId === asset.id) ?? false)
  const removeMedia = useProject((s) => s.removeMedia)

  const repair = useRepairMedia()
  const rename = useRenameMedia()
  const ctx = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [cutting, setCutting] = useState(false)
  const quickCut = useQuickCut()
  const [merging, setMerging] = useState(false)
  const mergeClips = useMergeClips()
  // A missing original can't be added (its proxy, if any, may describe a file
  // that's gone) until it is relinked below.
  const status = asset.status ?? 'ok'
  const ready = asset.proxyReady && status === 'ok'

  // Right-click: Quick cut… (docs/QUICK-CUT.md), Rename… (docs/MEDIA-POINTERS.md
  // "Rename") and Reveal in Explorer. All need the file, so a Missing or
  // unknown clip greys them out.
  const noFile = isUnknownClip(asset)
    ? 'This clip has no known file. Relink it first.'
    : status !== 'ok'
      ? 'The file is missing. Relink it first.'
      : undefined
  // Quick cut needs a video whose preview proxy is ready (the dialog plays it).
  const noCut =
    noFile ??
    (assetKind(asset) !== 'video'
      ? 'Quick cut works on video clips.'
      : !asset.proxyReady
        ? 'The preview is still being prepared.'
        : undefined)
  // Merge clips (docs/MERGE-CLIPS.md) reads the originals, so no proxy is needed,
  // but it needs another video to join this one to.
  const noMerge =
    noFile ??
    (assetKind(asset) !== 'video'
      ? 'Merge works on video clips.'
      : mergeable.length < 2
        ? 'The library needs another video clip to merge with.'
        : undefined)
  // The shared library takes sounds, pictures and video (a copy of the file).
  const shareTab = sharedKindOf(assetKind(asset))
  const noShare = noFile ?? (shareTab ? undefined : 'Only sounds, pictures and video can be shared.')
  const menuItems = (): ContextMenuEntry[] => [
    { label: 'Quick cut…', testId: 'ctx-quickcut', disabled: !!noCut, reason: noCut, onSelect: () => setCutting(true) },
    {
      label: 'Merge clips…',
      testId: 'ctx-merge',
      disabled: !!noMerge,
      reason: noMerge,
      onSelect: () => setMerging(true)
    },
    { label: 'Rename…', testId: 'ctx-rename', disabled: !!noFile, reason: noFile, onSelect: () => setRenaming(true) },
    {
      label: 'Reveal in Explorer',
      testId: 'ctx-reveal',
      disabled: !!noFile,
      reason: noFile,
      onSelect: () => void revealFile(asset.originalPath)
    },
    MENU_SEPARATOR,
    {
      // Opens the shared library on the clip's tab, which copies it in and
      // says how that went (docs/SHARED-LIBRARY.md).
      label: 'Add to shared library',
      testId: 'ctx-add-shared',
      disabled: !!noShare,
      reason: noShare,
      onSelect: () => {
        if (shareTab) useUi.getState().setSharedOpen({ tab: shareTab, addMediaId: asset.id })
      }
    }
  ]
  const onContextMenu = (e: React.MouseEvent): void => ctx.open(e, menuItems())
  const overlays = (
    <>
      {ctx.menu}
      {renaming && (
        <RenameMediaDialog
          asset={asset}
          onClose={() => setRenaming(false)}
          onRename={async (stem) => {
            await rename(asset.id, stem)
            setRenaming(false)
          }}
        />
      )}
      {cutting && (
        <QuickCutDialog
          asset={asset}
          onClose={() => setCutting(false)}
          onSave={async (pieces) => {
            await quickCut.mutateAsync({ mediaId: asset.id, pieces })
            setCutting(false)
          }}
          onSaveOne={async (pieces) => {
            await mergeClips.mutateAsync(pieces.map((p) => ({ mediaId: asset.id, ...p })))
            setCutting(false)
          }}
        />
      )}
      {merging && (
        <MergeClipsDialog
          clips={mergeable}
          firstId={asset.id}
          onClose={() => setMerging(false)}
          onMerge={async (segments) => {
            await mergeClips.mutateAsync(segments)
            setMerging(false)
          }}
        />
      )}
    </>
  )

  const isImage = isImageAsset(asset)
  // The same class `placeAsset` and a timeline drop use (an MP3 with cover art is a sound).
  const isAudio = isAudioAsset(asset)
  // A workout lands as an overlay (docs/WORKOUT-OVERLAY.md): at the playhead it
  // syncs to the footage there when that was filmed during the workout.
  const isWorkout = isWorkoutAsset(asset)
  const selected = selectedId === asset.id
  const pct = Math.round((job?.progress ?? 0) * 100)

  // Where to drop a new layer: the playhead, or the end of the current timeline.
  const playhead = (): number => usePlayback.getState().time
  const endOfTimeline = (): number => visualDuration(useProject.getState().project?.layers ?? [])
  const addVideoAt = (startSec: number): void => {
    if (ready) placeAsset(asset, startSec)
  }
  const addImageAt = addVideoAt
  // Real buttons, so the keyboard reaches them (Tab, then Enter). Not ready =
  // `disabled`; it also lets clicks through to the card, as before.
  const notReadyCls = 'disabled:pointer-events-none disabled:opacity-30'
  const addBtn = `rounded bg-sky-500/20 px-1 py-0.5 text-center text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/40 whitespace-nowrap ${notReadyCls}`

  // The add / remove action column — the Library's variant of the shared card.
  const actions = (
    <>
      {isWorkout ? (
        <>
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation()
              void placeWorkout(asset, playhead(), true)
            }}
            className={addBtn}
            title="Add the workout overlay at the playhead (synced to the clip there when it was filmed during the workout)"
          >
            ＋ Playhead
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation()
              void placeWorkout(asset, endOfTimeline(), false)
            }}
            className={addBtn}
            title="Add the workout overlay to the end of the timeline (the whole workout, sped up)"
          >
            ＋ End
          </button>
        </>
      ) : isImage ? (
        <>
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation()
              addImageAt(playhead())
            }}
            className={addBtn}
            title="Add image at the playhead"
          >
            ＋ Playhead
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation()
              addImageAt(endOfTimeline())
            }}
            className={addBtn}
            title="Add image to the end of the timeline"
          >
            ＋ End
          </button>
        </>
      ) : isAudio ? (
        <button
          type="button"
          disabled={!ready}
          onClick={(e) => {
            e.stopPropagation()
            if (ready) placeAsset(asset, playhead())
          }}
          className={`rounded px-1 py-0.5 text-center text-[10px] font-semibold whitespace-nowrap transition ${
            onTrack ? 'bg-emerald-500/30 text-emerald-200' : 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/40'
          } ${notReadyCls}`}
          title="Add to audio track at the playhead"
        >
          ♪ Playhead
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation()
              addVideoAt(playhead())
            }}
            className={addBtn}
            title="Add clip at the playhead"
          >
            ＋ Playhead
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation()
              addVideoAt(endOfTimeline())
            }}
            className={addBtn}
            title="Add clip to the end of the timeline"
          >
            ＋ End
          </button>
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
        title="Remove from this project (your file stays where it is)"
      >
        ×
      </span>
    </>
  )

  const card = (
    <ClipCard
      asset={asset}
      selected={selected}
      onClick={() => select(asset.id)}
      draggable={ready}
      onDragStart={(e) => {
        if (!ready) {
          e.preventDefault()
          return
        }
        // Drag onto the timeline to place a layer at the drop position.
        e.dataTransfer.setData('application/x-reel-asset', asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onContextMenu={onContextMenu}
      proxyPct={pct}
      proxyError={job?.status === 'error'}
      trailing={actions}
    />
  )
  if (status === 'ok') {
    return (
      <>
        {card}
        {overlays}
      </>
    )
  }

  const busy = repair.relink.isPending
  return (
    <div className="rounded border border-amber-500/40" data-testid={`media-${status}`} onContextMenu={onContextMenu}>
      {card}
      {overlays}
      <div className="space-y-1 px-2 pb-1.5 pt-1 text-[10px] text-amber-200">
        {isUnknownClip(asset) ? (
          <p data-testid="media-unknown">
            Missing, unknown clip: the timeline uses it, but nothing records which file it was. Relink… to find it.
          </p>
        ) : (
          <p title={asset.absolutePath}>Missing: no file matching this clip at its saved location.</p>
        )}
        <div className="flex gap-1">
          <button
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              repair.relink.mutate(asset.id)
            }}
            className={`${btnCls} ${disabledCls} py-0.5 text-[10px]`}
            title="Find the file yourself (it must be the same footage)"
          >
            Relink…
          </button>
        </div>
      </div>
    </div>
  )
}

export function Library(): JSX.Element {
  const { data: assets = [], isLoading } = useLibrary()
  const importMedia = useImportMedia()
  // Videos Merge clips can read: a known file that is not Missing.
  const mergeable = assets.filter((a) => assetKind(a) === 'video' && !isUnknownClip(a) && (a.status ?? 'ok') === 'ok')

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
          <ClipRow key={asset.id} asset={asset} mergeable={mergeable} />
        ))}
      </div>
    </div>
  )
}
