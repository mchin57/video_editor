import { useEffect, useRef, type DragEvent, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Dock } from '@/components/Dock'
import { CropEditor } from '@/components/CropEditor'
import { StillsPopout } from '@/components/StillsPopout'
import { ImageEditPopout } from '@/components/ImageEditPopout'
import { ExportButton } from '@/components/ExportButton'
import { FileMenu } from '@/components/FileMenu'
import { ViewMenu } from '@/components/ViewMenu'
import { ProjectSettingsMenu } from '@/components/ProjectSettingsMenu'
import { CaptionAudioButton } from '@/components/CaptionAudioButton'
import { SettingsModal } from '@/components/SettingsModal'
import { ChecklistModal } from '@/components/ChecklistModal'
import { ScriptModal } from '@/components/ScriptModal'
import { StatusFooter } from '@/components/StatusFooter'
import { useImportMedia, useLibrary } from '@/hooks/useMedia'
import { useDragDepth } from '@/lib/dragDepth'
import { onJobProgress, pathForFile } from '@/ipc/client'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { makeTextLayer } from '@shared/layers'

export default function App(): JSX.Element {
  const queryClient = useQueryClient()
  const importMedia = useImportMedia()
  // Library assets via a ref so the (deps-[]) key handler can resolve an audio
  // clip's source duration without re-binding the listener on every refetch.
  const { data: assets = [] } = useLibrary()
  const assetsRef = useRef(assets)
  assetsRef.current = assets
  // OS-file drag highlight — depth-counted so dropping outside the app can't
  // leave the overlay stuck (library-item drags carry a custom type and are
  // filtered out here; the Timeline handles those).
  const fileDrag = useDragDepth((types) => types.includes('Files'))

  // Load the persisted project once on startup; flush any pending debounced
  // autosave on window unload so quitting inside the 400ms window can't lose
  // the last edit.
  useEffect(() => {
    void useProject.getState().load()
    const flush = (): void => useProject.getState().flushSave()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
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
      const mod = e.ctrlKey || e.metaKey
      // File shortcuts work everywhere, even while a text field has focus.
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const ps = useProject.getState()
        void (e.shiftKey ? ps.saveAs() : ps.save())
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void useProject.getState().openFile()
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        useProject.getState().newProjectFile()
        return
      }

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
        // Delete whatever is selected, matching the Inspector's priority.
        const ui = useUi.getState()
        if (ui.selectedLayerId) {
          e.preventDefault()
          project.removeLayer(ui.selectedLayerId)
        } else if (ui.selectedCaptionId) {
          e.preventDefault()
          project.removeCaption(ui.selectedCaptionId)
          ui.selectCaption(null)
        } else if (ui.selectedAudioId) {
          e.preventDefault()
          project.removeAudioClip(ui.selectedAudioId)
          ui.selectAudio(null)
        }
      } else if (e.key.toLowerCase() === 's') {
        const t = usePlayback.getState().time
        const ui = useUi.getState()
        if (ui.selectedAudioId) {
          // An audio clip is selected — split it at the playhead.
          const a = project.project?.audioClips.find((x) => x.id === ui.selectedAudioId)
          if (a) {
            const dur = assetsRef.current.find((m) => m.id === a.mediaId)?.probe.durationSec ?? a.outSec
            project.splitAudioAt(a.id, t, dur)
          }
        } else if (ui.selectedLayerId) {
          // A video layer is selected — split it at the playhead.
          const l = project.project?.layers.find((x) => x.id === ui.selectedLayerId)
          if (l && l.content.kind === 'video') project.splitLayerAt(l.id, t)
        }
      } else if (e.key.toLowerCase() === 't') {
        const id = crypto.randomUUID()
        const start = usePlayback.getState().time
        project.addLayer(makeTextLayer(id, start, start + 3))
        useUi.getState().selectLayer(id)
      } else if (e.key === 'Escape') {
        const ui = useUi.getState()
        ui.setCropEditing(false)
        ui.setSettingsOpen(false)
        ui.setChecklistOpen(false)
        ui.setScriptOpen(false)
        ui.setStillsOpen(false)
        ui.setImageEditOpen(false)
        ui.clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    fileDrag.reset()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => pathForFile(f))
      .filter(Boolean)
    if (paths.length) importMedia.mutate(paths)
  }

  return (
    <div
      className="relative flex h-full select-none flex-col bg-[#0b0b0f]"
      onDragEnter={fileDrag.onDragEnter}
      onDragOver={(e) => {
        // Only react to OS file drags (import); library-item drags onto the
        // timeline carry a custom type and are handled by the Timeline itself.
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
      }}
      onDragLeave={fileDrag.onDragLeave}
      onDrop={onDrop}
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <span className="text-sm font-bold tracking-tight text-zinc-100">Reel Editor</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">prototype</span>
        <FileMenu />
        <ViewMenu />
        <ProjectSettingsMenu />
        <div className="flex-1" />
        <button
          onClick={() => importMedia.mutate(undefined)}
          disabled={importMedia.isPending}
          className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20 disabled:opacity-50"
        >
          {importMedia.isPending ? 'Importing…' : 'Import video'}
        </button>
        <CaptionAudioButton />
        <button
          onClick={() => useUi.getState().setScriptOpen(!useUi.getState().scriptOpen)}
          title="Script / talking points"
          className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
        >
          📝 Script
        </button>
        <button
          onClick={() => useUi.getState().setChecklistOpen(true)}
          title="Reel checklist — score this reel against Instagram best practices"
          className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
        >
          ✓ Checklist
        </button>
        <ExportButton />
        <button
          onClick={() => useUi.getState().setSettingsOpen(true)}
          title="Settings"
          className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
        >
          ⚙
        </button>
      </header>

      <div className="min-h-0 flex-1">
        <Dock />
      </div>

      <StatusFooter />

      <CropEditor />
      <StillsPopout />
      <ImageEditPopout />
      <SettingsModal />
      <ChecklistModal />
      <ScriptModal />

      {fileDrag.active && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-sky-400/70 px-8 py-6 text-sm font-medium text-sky-200">
            Drop video files to import
          </div>
        </div>
      )}
    </div>
  )
}
