import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MediaAsset } from '@shared/media'
import type { AudioFxSettings } from '@shared/audioFx'
import { extractAudioDialog, importDialog, importPaths, listProjectMedia, renderAudioFx } from '@/ipc/client'
import { useEditor } from '@/state/store'
import { activeComp, useProject } from '@/state/projectStore'

const LIBRARY_KEY = 'library'

/**
 * The current project's media library. Scoped to the project's `mediaIds`, so it
 * refetches whenever media is added/removed or a different project is opened.
 */
export function useLibrary(): ReturnType<typeof useQuery<MediaAsset[]>> {
  const mediaIds = useProject((s) => s.project?.mediaIds)
  return useQuery({
    queryKey: [LIBRARY_KEY, mediaIds],
    queryFn: () => listProjectMedia(mediaIds ?? []),
    enabled: mediaIds != null
  })
}

/** Import via the OS dialog (no args) or from explicit paths (drag-and-drop). */
export function useImportMedia(): ReturnType<
  typeof useMutation<MediaAsset[], Error, string[] | undefined>
> {
  const qc = useQueryClient()
  const select = useEditor((s) => s.select)
  return useMutation<MediaAsset[], Error, string[] | undefined>({
    mutationFn: (paths) => (paths && paths.length ? importPaths(paths) : importDialog()),
    onSuccess: (assets) => {
      // Scope the freshly imported assets to the current project, then refresh.
      useProject.getState().addMedia(assets.map((a) => a.id))
      void qc.invalidateQueries({ queryKey: [LIBRARY_KEY] })
      if (assets[0]) select(assets[0].id)
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
    onSuccess: (asset) => {
      if (!asset) return // dialog canceled
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
    onSuccess: (asset, input) => {
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
