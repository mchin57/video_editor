import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MediaAsset } from '@shared/media'
import { extractAudioDialog, importDialog, importPaths, listProjectMedia } from '@/ipc/client'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'

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
