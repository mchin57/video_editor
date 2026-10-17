import { useEffect, useRef, useState, type DragEvent, type JSX, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Dock } from '@/components/Dock'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { CropEditor } from '@/components/CropEditor'
import { StillsPopout } from '@/components/StillsPopout'
import { ImageEditPopout } from '@/components/ImageEditPopout'
import { ExportButton } from '@/components/ExportButton'
import { FileMenu } from '@/components/FileMenu'
import { ViewMenu } from '@/components/ViewMenu'
import { FormatMenu } from '@/components/FormatMenu'
import { ProjectSettingsMenu } from '@/components/ProjectSettingsMenu'
import { JobsIndicator } from '@/components/JobsIndicator'
import { CaptionAudioButton } from '@/components/CaptionAudioButton'
import { SettingsModal } from '@/components/SettingsModal'
import { ChecklistModal } from '@/components/ChecklistModal'
import { ScriptModal } from '@/components/ScriptModal'
import { StatusFooter } from '@/components/StatusFooter'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { StartScreen } from '@/components/StartScreen'
import { VolumeLevelDialog } from '@/components/VolumeLevelDialog'
import { ImportFailures } from '@/components/ImportFailures'
import { useImportMedia, useLibrary } from '@/hooks/useMedia'
import { useDragDepth } from '@/lib/dragDepth'
import { interactionOpen } from '@/lib/interaction'
import { refetchFresh } from '@/lib/refetchFresh'
import {
  chooseProjectLocation,
  defaultProjectLocation,
  onImportSkipped,
  onJobProgress,
  onLibraryChanged,
  pathForFile
} from '@/ipc/client'
import { useEditor } from '@/state/store'
import { getFormat, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { useAppSettings } from '@/state/appSettings'
import { useLoudness } from '@/state/loudness'
import { makeTextLayer } from '@shared/layers'
import { newId } from '@shared/ids'

/**
 * File ▸ New's window (docs/MEDIA-POINTERS.md "The project folder"): a name
 * and a location, starting from the Settings export folder. Creating makes the
 * project folder and opens it.
 */
function NewProjectWindow(): JSX.Element {
  const open = useUi((s) => s.newProjectOpen)
  const [location, setLocation] = useState('')
  useEffect(() => {
    if (open) void defaultProjectLocation().then(setLocation)
  }, [open])
  const close = (): void => useUi.getState().setNewProjectOpen(false)
  return (
    <NewProjectDialog
      open={open}
      onClose={close}
      defaultLocation={location}
      onChooseLocation={(current) => chooseProjectLocation(current)}
      onCreate={async (name, where) => {
        await useProject.getState().createProject(name, where)
        close()
      }}
    />
  )
}

/**
 * One part of the window outside the dock (header, footer, the modals and
 * popouts), behind its own error boundary: a render error there shows a strip
 * in its place and leaves the dock and the key handler (Ctrl+Z) running,
 * instead of unmounting the window. Retries on any project change, like
 * `DockPanel`. `floating` puts the strip over the window, for the overlays.
 */
function Section({ name, floating, children }: { name: string; floating?: boolean; children: ReactNode }): JSX.Element {
  const project = useProject((s) => s.project)
  return (
    <ErrorBoundary
      label={name}
      resetKey={project}
      fallback={(error, retry) => (
        <div
          role="alert"
          data-testid="section-error"
          className={`flex items-center gap-3 whitespace-nowrap border-rose-500/40 bg-rose-950/60 px-4 py-1.5 text-xs ${
            floating ? 'fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded border' : 'border-y'
          }`}
        >
          <span className="text-rose-200">The {name} hit an error and stopped drawing.</span>
          <span className="min-w-0 truncate font-mono text-[10px] text-zinc-400">{error.message}</span>
          <span className="text-zinc-400">Undo (Ctrl+Z) the last change, or</span>
          <button onClick={retry} className="rounded bg-white/10 px-2 py-0.5 text-zinc-200 hover:bg-white/20">
            Try again
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * The last-resort boundary around the whole app (main.tsx), for a render error
 * no section caught (the start screen, App itself). App's key handler is gone
 * with it, so the fallback offers Undo as a button. Unmounting the dock here
 * leaves its saved layout alone (e2e/rootCrash.spec.ts).
 */
export function AppErrorBoundary({ children }: { children: ReactNode }): JSX.Element {
  const project = useProject((s) => s.project)
  return (
    <ErrorBoundary
      label="App"
      resetKey={project}
      fallback={(error, retry) => (
        <div
          role="alert"
          data-testid="app-error"
          className="flex h-full flex-col items-center justify-center gap-3 bg-[#0b0b0f] p-8 text-center text-sm text-zinc-300"
        >
          <p className="text-rose-300">Reel Editor hit an error and stopped drawing.</p>
          <p className="max-w-xl break-words font-mono text-xs text-zinc-500">{error.message}</p>
          <p className="text-zinc-400">Your project is still open. Undo the last change, or try again.</p>
          <div className="flex gap-2">
            <button
              onClick={() => useProject.getState().undo()}
              className="rounded-md bg-white/10 px-3 py-1 text-xs text-zinc-200 hover:bg-white/20"
            >
              Undo
            </button>
            <button
              onClick={retry}
              className="rounded-md bg-white/10 px-3 py-1 text-xs text-zinc-200 hover:bg-white/20"
            >
              Try again
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

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
    void useAppSettings.getState().load()
    const flush = (): void => useProject.getState().flushSave()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // Main's library changed after open (import, relink, a path fixed by a
  // re-check): unsaved changes, and the library list is stale.
  useEffect(
    () =>
      onLibraryChanged(() => {
        useProject.getState().markLibraryChanged()
        useLoudness.getState().refresh()
        void queryClient.invalidateQueries({ queryKey: ['library'] })
      }),
    [queryClient]
  )

  // Files an import couldn't take: the import notice (ImportFailures) names them.
  useEffect(() => onImportSkipped((skipped) => useUi.getState().setImportSkipped(skipped)), [])

  // Subscribe to background job progress; refresh library when a proxy lands.
  useEffect(() => {
    const applyJobEvent = useEditor.getState().applyJobEvent
    return onJobProgress((ev) => {
      applyJobEvent(ev)
      if (ev.type === 'proxy' && ev.status === 'done') {
        // Not a plain invalidate: a library fetch already running read the
        // asset before its proxy existed (lib/refetchFresh.ts).
        void refetchFresh(queryClient, ['library'])
      }
    })
  }, [queryClient])

  // Keyboard shortcuts: space play/pause, Ctrl+Z/Y undo/redo, Del delete, S split,
  // N snap-to-previous, T text layer, M mute/unmute.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      // Mid-drag, any edit would be overwritten by the drag's next move and folded
      // into (or orphaned by) its undo step on release; New/Open would get the old
      // snapshot written into them. Only save and play/pause act until release.
      if (interactionOpen() && !(mod && e.key.toLowerCase() === 's') && e.code !== 'Space') return
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
        void useProject.getState().newProjectFile()
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
        // Delete the whole selection (one tile, or every tile of a link group).
        const { selection } = useUi.getState()
        if (selection.length) {
          e.preventDefault()
          project.removeItems(selection)
        }
      } else if (e.key.toLowerCase() === 's') {
        // Split the selection at the playhead — every selected tile it crosses.
        const { selection } = useUi.getState()
        if (selection.length) {
          project.splitItemsAt(
            selection,
            usePlayback.getState().time,
            (mediaId) => assetsRef.current.find((m) => m.id === mediaId)?.probe.durationSec ?? 0
          )
        }
      } else if (!mod && e.key.toLowerCase() === 'n') {
        // Butt the selection against the previous clip in its lane (no gap).
        const { selection } = useUi.getState()
        if (selection.length) {
          project.snapItemsToPrevious(
            selection,
            (mediaId) => assetsRef.current.find((m) => m.id === mediaId)?.probe.durationSec ?? 0
          )
        }
      } else if (!mod && e.key.toLowerCase() === 'm') {
        // Mute / unmute the selection's sound (audio clips, video layers' own audio).
        const { selection } = useUi.getState()
        if (selection.length) project.toggleMuteItems(selection)
      } else if (e.key.toLowerCase() === 't') {
        const id = newId()
        const start = usePlayback.getState().time
        project.addLayer(makeTextLayer(id, start, start + 3, getFormat().frame))
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

  const loaded = useProject((s) => s.loaded)
  const hasProject = useProject((s) => !!s.project)
  const launchMessage = useProject((s) => s.launchMessage)

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    fileDrag.reset()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => pathForFile(f))
      .filter(Boolean)
    if (paths.length) importMedia.mutate(paths)
  }

  // No project open (first launch, or the last one couldn't be reopened): the
  // start screen. There is no untitled project to fall back on.
  if (loaded && !hasProject) {
    return (
      <div className="relative h-full select-none bg-[#0b0b0f]">
        <StartScreen
          message={launchMessage ?? undefined}
          onNew={() => void useProject.getState().newProjectFile()}
          onOpen={() => void useProject.getState().openFile()}
        />
        <NewProjectWindow />
        <SettingsModal />
      </div>
    )
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
      <Section name="header">
        {/* One line always: labels never wrap; a running job's indicator truncates instead (JobsIndicator). */}
        <header
          data-app-header
          className="flex items-center gap-3 whitespace-nowrap border-b border-white/10 px-4 py-2"
        >
          <span className="text-sm font-bold tracking-tight text-zinc-100">Reel Editor</span>
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">prototype</span>
          <FileMenu />
          <ViewMenu />
          <FormatMenu />
          <ProjectSettingsMenu />
          <JobsIndicator />
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
      </Section>

      <div className="min-h-0 flex-1">
        <Dock />
      </div>

      <Section name="status bar">
        <StatusFooter />
      </Section>

      <Section name="popouts and dialogs" floating>
        <CropEditor />
        <StillsPopout />
        <ImageEditPopout />
        <SettingsModal />
        <ChecklistModal />
        <ScriptModal />
        <NewProjectWindow />
        <VolumeLevelDialog />
        <ImportFailures />
      </Section>

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
