import { useEffect, useState, type DragEvent, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Library } from '@/components/Library'
import { PreviewStage } from '@/components/PreviewStage'
import { Inspector } from '@/components/Inspector'
import { StatusFooter } from '@/components/StatusFooter'
import { useImportMedia } from '@/hooks/useMedia'
import { onJobProgress, pathForFile } from '@/ipc/client'
import { useEditor } from '@/state/store'

export default function App(): JSX.Element {
  const queryClient = useQueryClient()
  const importMedia = useImportMedia()
  const [dragging, setDragging] = useState(false)

  // Subscribe to background job progress; refresh library when a proxy lands.
  useEffect(() => {
    const applyJobEvent = useEditor.getState().applyJobEvent
    return onJobProgress((ev) => {
      applyJobEvent(ev)
      if (ev.type === 'proxy' && ev.status === 'done') {
        void queryClient.invalidateQueries({ queryKey: ['library'] })
      }
    })
  }, [queryClient])

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => pathForFile(f))
      .filter(Boolean)
    if (paths.length) importMedia.mutate(paths)
  }

  return (
    <div
      className="relative flex h-full flex-col bg-[#0b0b0f]"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <span className="text-sm font-bold tracking-tight text-zinc-100">Reel Editor</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">prototype</span>
        <div className="flex-1" />
        <button
          onClick={() => importMedia.mutate(undefined)}
          disabled={importMedia.isPending}
          className="rounded-md bg-sky-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        >
          {importMedia.isPending ? 'Importing…' : 'Import video'}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="border-r border-white/10">
          <Library />
        </aside>

        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="h-full max-h-[78vh]">
            <PreviewStage />
          </div>
        </main>

        <aside className="border-l border-white/10">
          <Inspector />
        </aside>
      </div>

      <div className="flex h-28 items-center justify-center border-t border-white/10 bg-black/20 text-xs text-zinc-600">
        Timeline (M2)
      </div>

      <StatusFooter />

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-sky-400/70 px-8 py-6 text-sm font-medium text-sky-200">
            Drop video files to import
          </div>
        </div>
      )}
    </div>
  )
}
