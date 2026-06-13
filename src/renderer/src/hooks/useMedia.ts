import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MediaAsset } from '@shared/media'
import { importDialog, importPaths, listLibrary, removeMedia } from '@/ipc/client'
import { useEditor } from '@/state/store'

const LIBRARY_KEY = ['library'] as const

export function useLibrary(): ReturnType<typeof useQuery<MediaAsset[]>> {
  return useQuery({ queryKey: LIBRARY_KEY, queryFn: listLibrary })
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
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY })
      if (assets[0]) select(assets[0].id)
    }
  })
}

export function useRemoveMedia(): ReturnType<typeof useMutation<void, Error, string>> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: removeMedia,
    onSuccess: () => void qc.invalidateQueries({ queryKey: LIBRARY_KEY })
  })
}
