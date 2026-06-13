import { useEffect, useState, type DragEvent, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Library } from '@/components/Library'
import { PreviewStage } from '@/components/PreviewStage'
import { Inspector } from '@/components/Inspector'
import { Timeline } from '@/components/Timeline'
import { CropEditor } from '@/components/CropEditor'
import { Splitter } from '@/components/Splitter'
import { StatusFooter } from '@/components/StatusFooter'
import { useImportMedia } from '@/hooks/useMedia'
import { onJobProgress, pathForFile } from '@/ipc/client'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { locate } from '@/lib/timeline'
import { makeOverlay } from '@/lib/overlays'

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

interface PanelSizes {
  libW: number
  inspW: number
  tlH: number
}

function loadPanelSizes(): PanelSizes {
  try {
    const saved = JSON.parse(localStorage.getItem('panelSizes') ?? '{}')
    return { libW: saved.libW ?? 256, inspW: saved.inspW ?? 256, tlH: saved.tlH ?? 176 }
  } catch {
    return { libW: 256, inspW: 256, tlH: 176 }
  }
}

export default function App(): JSX.Element {
  const queryClient = useQueryClient()
  const importMedia = useImportMedia()
  const [dragging, setDragging] = useState(false)
  const [panels, setPanels] = useState<PanelSizes>(loadPanelSizes)

  useEffect(() => {
    localStorage.setItem('panelSizes', JSON.stringify(panels))
  }, [panels])

  // Load the persisted project once on startup.
  useEffect(() => {
    void useProject.getState().load()
  }, [])

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

  // Keyboard shortcuts: space play/pause, Ctrl+Z/Y undo/redo, Del delete, S split.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const project = useProject.getState()
      if (e.code === 'Space') {
        e.preventDefault()
        usePlayback.getState().toggle()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) project.redo()
        else project.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        project.redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (project.selectedClipId) {
          e.preventDefault()
          project.removeClip(project.selectedClipId)
        }
      } else if (e.key.toLowerCase() === 's') {
        const clips = project.project?.clips ?? []
        const idx = clips.findIndex((c) => c.id === project.selectedClipId)
        const pos = locate(clips, usePlayback.getState().time)
        if (idx >= 0 && pos && pos.index === idx) project.splitClipAt(clips[idx].id, pos.localTime)
      } else if (e.key.toLowerCase() === 't') {
        if ((project.project?.clips.length ?? 0) > 0) {
          const id = crypto.randomUUID()
          const start = usePlayback.getState().time
          project.addOverlay(makeOverlay(id, start, start + 3))
          useUi.getState().selectOverlay(id)
        }
      } else if (e.key === 'Escape') {
        useUi.getState().setCropEditing(false)
        useUi.getState().selectOverlay(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      className="relative flex h-full select-none flex-col bg-[#0b0b0f]"
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
        <aside style={{ width: panels.libW }} className="shrink-0 border-r border-white/10">
          <Library />
        </aside>
        <Splitter
          orientation="vertical"
          onDrag={(d) => setPanels((p) => ({ ...p, libW: clamp(p.libW + d, 180, 520) }))}
        />

        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="h-full max-h-[78vh]">
            <PreviewStage />
          </div>
        </main>

        <Splitter
          orientation="vertical"
          onDrag={(d) => setPanels((p) => ({ ...p, inspW: clamp(p.inspW - d, 180, 520) }))}
        />
        <aside style={{ width: panels.inspW }} className="shrink-0 border-l border-white/10">
          <Inspector />
        </aside>
      </div>

      <Splitter
        orientation="horizontal"
        onDrag={(d) => setPanels((p) => ({ ...p, tlH: clamp(p.tlH - d, 120, 460) }))}
      />
      <div style={{ height: panels.tlH }} className="shrink-0 border-t border-white/10 bg-black/20">
        <Timeline />
      </div>

      <StatusFooter />

      <CropEditor />

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
