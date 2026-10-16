import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MediaAsset } from '@shared/media'
import type { AudioFxSettings } from '@shared/audioFx'
import type { QuickCutRequest, RelinkResult } from '@shared/ipc'
import type { MergeSegment } from '@shared/merge'
import {
  ensureProxy,
  extractAudioDialog,
  importDialog,
  importFolderDialog,
  importPaths,
  listProjectMedia,
  ipcErrorMessage,
  mergeClips,
  quickCut,
  relinkMediaDialog,
  renameMedia,
  renderAudioFx,
  setMediaDescription
} from '@/ipc/client'
import { normalizeDescription } from '@shared/media'
import { useEditor } from '@/state/store'
import { activeComp, useProject } from '@/state/projectStore'
import { useLoudness } from '@/state/loudness'
import { idle } from '@/lib/interaction'

const LIBRARY_KEY = 'library'

/**
 * The current project's media library. Scoped to the project's `mediaIds`, so it
 * refetches whenever media is added/removed or a different project is opened.
 */
export function useLibrary(): ReturnType<typeof useQuery<MediaAsset[]>> {
  const mediaIds = useProject((s) => s.project?.mediaIds)
  // The folder is part of the key: the same ids in another project folder
  // (Save As, Open) are different files on disk.
  const filePath = useProject((s) => s.filePath)
  return useQuery({
    queryKey: [LIBRARY_KEY, filePath, mediaIds],
    queryFn: () => listProjectMedia(mediaIds ?? []),
    enabled: mediaIds != null,
    // Coming back to the app (typically from Explorer) is when a source may
    // have been overwritten or a media file deleted: re-check then. Each check
    // is a stat per asset; only a mismatch costs a re-hash (main memoizes it).
    refetchOnWindowFocus: true
  })
}

/**
 * Import via the OS dialog (no args) or from explicit paths (drag-and-drop).
 * A path may be a FOLDER — main expands it to the media inside.
 */
export function useImportMedia(): ReturnType<
  typeof useMutation<MediaAsset[], Error, string[] | undefined>
> {
  const qc = useQueryClient()
  const select = useEditor((s) => s.select)
  return useMutation<MediaAsset[], Error, string[] | undefined>({
    mutationFn: (paths) => (paths && paths.length ? importPaths(paths) : importDialog()),
    onSuccess: (assets) => onImported(assets, qc, select)
  })
}

/** File ▸ Import folder… — pick directories, import every supported file in them. */
export function useImportFolder(): ReturnType<typeof useMutation<MediaAsset[], Error, void>> {
  const qc = useQueryClient()
  const select = useEditor((s) => s.select)
  return useMutation<MediaAsset[], Error, void>({
    mutationFn: () => importFolderDialog(),
    onSuccess: (assets) => onImported(assets, qc, select)
  })
}

/** Shared post-import step for every import route: scope the new assets to the
 *  project, refresh the library, and select the first one. Waits for any open
 *  drag first: at the root a drag recomputes the WHOLE project from its
 *  pointerdown snapshot, so ids added mid-drag would vanish (lib/interaction.ts). */
async function onImported(
  assets: MediaAsset[],
  qc: ReturnType<typeof useQueryClient>,
  select: (id: string) => void
): Promise<void> {
  await idle()
  useProject.getState().addMedia(assets.map((a) => a.id))
  void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
  if (assets[0]) select(assets[0].id)
}

/**
 * Library ▸ Quick cut… ▸ Save: encode one new clip per piece (main, ffmpeg) and
 * add them to the project's library like any import — the first is selected.
 * Errors reject the call so the dialog can show them inline.
 */
export function useQuickCut(): ReturnType<typeof useMutation<MediaAsset[], Error, QuickCutRequest>> {
  const qc = useQueryClient()
  const select = useEditor((s) => s.select)
  return useMutation<MediaAsset[], Error, QuickCutRequest>({
    mutationFn: (req) => quickCut(req),
    onSuccess: (assets) => onImported(assets, qc, select)
  })
}

/**
 * Merge clips (Library ▸ Merge clips…, Quick cut ▸ Save as one clip): encode
 * the segments into ONE new clip and add it to the library like an import —
 * it is selected. Errors reject so the dialog can show them inline.
 */
export function useMergeClips(): ReturnType<typeof useMutation<MediaAsset, Error, MergeSegment[]>> {
  const qc = useQueryClient()
  const select = useEditor((s) => s.select)
  return useMutation<MediaAsset, Error, MergeSegment[]>({
    mutationFn: (segments) => mergeClips(segments),
    onSuccess: (asset) => onImported([asset], qc, select)
  })
}

/**
 * A clip's description (`MediaRecord.description`; '' clears). Shown at once
 * in every open library list, then saved in main — whose change notice marks
 * the project unsaved and refetches. A failure puts the saved text back.
 */
export function useSetDescription(): ReturnType<typeof useMutation<void, Error, { id: string; text: string }>> {
  const qc = useQueryClient()
  return useMutation<void, Error, { id: string; text: string }>({
    mutationFn: ({ id, text }) => setMediaDescription(id, text),
    onMutate: ({ id, text }) => {
      const description = normalizeDescription(text) || undefined
      qc.setQueriesData<MediaAsset[]>({ queryKey: [LIBRARY_KEY] }, (old) =>
        old?.map((a) => (a.id === id ? { ...a, description } : a))
      )
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
      window.alert(`The description was not saved: ${ipcErrorMessage(err)}`)
    }
  })
}

/**
 * File ▸ Extract audio from clip… — pick a video, pull its audio into the current
 * project's library as a standalone audio asset (ready to drag onto the music
 * track). Surfaces a "no audio track" error from the picked file.
 */
export function useExtractAudio(): ReturnType<
  typeof useMutation<MediaAsset | null, Error, void>
> {
  const qc = useQueryClient()
  return useMutation<MediaAsset | null, Error, void>({
    mutationFn: () => extractAudioDialog(),
    onSuccess: async (asset) => {
      if (!asset) return // dialog canceled
      await idle() // see onImported
      useProject.getState().addMedia([asset.id])
      void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
    },
    onError: (err) => window.alert(err.message)
  })
}

/** What "add sound effect" needs to know: the effect, the audio to build it
 *  from, and where the resulting track lands on the timeline. */
export interface AddAudioFxInput {
  settings: AudioFxSettings
  /** Library asset holding the dry signal. */
  sourceMediaId: string
  /** Source window to render (the source clip's own in/out points). */
  inSec: number
  outSec: number
  /** Timeline position for the new track — the dry clip's start, so the
   *  effect lines up with the sound it came from. */
  startSec: number
  /** Link group of the source clip, if any — the effect joins it so the two
   *  move and split together instead of drifting apart. */
  linkGroupId?: string
  /** Re-render an EXISTING effect track in place (swapping its audio) rather
   *  than adding another one. Its timeline position and mix settings survive. */
  replaceClipId?: string
}

/**
 * Render an effect's wet signal and drop it on the timeline as its own track.
 *
 * The render happens in main (ffmpeg) and lands as a normal library asset, so
 * everything after this point is an ordinary audio clip: it previews through
 * the same `<audio>` follower, exports through the same mix, and can be moved,
 * trimmed, faded and split like any other. @see shared/audioFx.ts
 */
export function useAddAudioFx(): ReturnType<
  typeof useMutation<MediaAsset, Error, AddAudioFxInput>
> {
  const qc = useQueryClient()
  return useMutation<MediaAsset, Error, AddAudioFxInput>({
    mutationFn: (input) =>
      renderAudioFx({
        settings: input.settings,
        sourceMediaId: input.sourceMediaId,
        inSec: input.inSec,
        outSec: input.outSec
      }),
    onSuccess: async (asset, input) => {
      await idle() // the render can finish mid-drag; see onImported
      const store = useProject.getState()
      store.addMedia([asset.id])
      const fx = {
        settings: input.settings,
        fromMediaId: input.sourceMediaId,
        fromInSec: input.inSec,
        fromOutSec: input.outSec
      }
      if (input.replaceClipId) {
        // Re-render: swap the audio under the existing track(s), keeping where
        // each sits, how it is mixed, and — importantly — how it is TRIMMED. A
        // new setting means a new content hash, so this points at a different
        // asset; the old one stays in the library.
        //
        // Splitting an effect track leaves SEVERAL clips over one rendered
        // file, each carrying the same provenance. They are all re-pointed
        // together: updating only the selected piece would leave its siblings
        // playing the previous render.
        const clips = activeComp(useProject.getState())?.audioClips ?? []
        const from = clips.find((c) => c.id === input.replaceClipId)?.mediaId
        if (from) store.replaceAudioFxRender(from, asset.id, fx)
        void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
        return
      }
      store.addAudioClip({
        id: crypto.randomUUID(),
        mediaId: asset.id,
        startSec: input.startSec,
        inSec: 0,
        // The rendered file IS the effect, tail included — take all of it.
        outSec: 0,
        gainDb: 0,
        fadeInSec: 0,
        fadeOutSec: 0,
        // An effect track is a layer of the same performance, not a bed to duck
        // under it, and captioning it would transcribe the dry words twice.
        duck: false,
        excludeFromCaptions: true,
        ...(input.linkGroupId ? { linkGroupId: input.linkGroupId } : {}),
        kind: 'fx',
        fx
      })
      void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
    },
    onError: (err) => window.alert(err.message)
  })
}

/**
 * A library card's repair action for a `missing` original
 * (docs/MEDIA-POINTERS.md "Relink"): point it at a file (main asks "Update
 * path anyway?" when it doesn't match). A file of a different length resets
 * the clip's cuts on the timeline (one undo step). The proxy is rebuilt if the
 * cache no longer has one.
 */
export function useRepairMedia(): {
  relink: ReturnType<typeof useMutation<RelinkResult | null, Error, string>>
} {
  const qc = useQueryClient()
  const done = (result: RelinkResult | null): void => {
    void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
    if (!result) return
    const { asset } = result
    if (result.cutsReset) useProject.getState().resetMediaCuts(asset.id, asset.probe.durationSec)
    if (!asset.proxyReady) {
      void ensureProxy(asset.id)
        .catch((err) => console.error('proxy rebuild failed', err))
        .finally(() => void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] }))
    }
  }
  const relink = useMutation<RelinkResult | null, Error, string>({
    mutationFn: (id) => relinkMediaDialog(id),
    onSuccess: done,
    onError: (err) => window.alert(err.message)
  })
  return { relink }
}

/**
 * A library card's Rename (docs/MEDIA-POINTERS.md "Rename"): main renames the
 * file on disk, then the record; then the library is marked changed and the
 * project SAVED at once, so the `.reel` names the file by its new name (owner
 * decision — an unsaved rename would leave the `.reel` naming a file that no
 * longer exists). Rejects with main's reason, cleaned for showing inline.
 */
export function useRenameMedia(): (id: string, stem: string) => Promise<void> {
  const qc = useQueryClient()
  return async (id, stem) => {
    try {
      await renameMedia(id, stem)
    } catch (err) {
      throw new Error(ipcErrorMessage(err))
    }
    const store = useProject.getState()
    store.markLibraryChanged()
    useLoudness.getState().refresh() // a Rename isn't broadcast: retry series that failed under the old name
    void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
    try {
      await store.save()
    } catch (err) {
      // The file IS renamed; only the save failed. Say so, and let the dialog close.
      window.alert(`The file was renamed, but the project couldn't be saved: ${ipcErrorMessage(err)}\n\nUse File ▸ Save.`)
    }
  }
}
