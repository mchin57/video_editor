import { useState, type JSX } from 'react'
import { presetFor } from '@shared/formats'
import { useProject } from '@/state/projectStore'
import { latestJob, useEditor } from '@/state/store'
import { exportProject, revealFile } from '@/ipc/client'
import { exportSaveSkipReason, type ExportOrigin } from '@/lib/exportSave'
import { CancelJobButton } from './JobsIndicator'

/**
 * Exports the current timeline to the selected preset (.mp4, NVENC when
 * available). Shows live progress, then a Reveal action on success. A finished
 * export also saves the project (the store's `save`, exactly File > Save — so
 * edits made while it rendered are saved too) — but only if that project is
 * still the open one (`exportSaveSkipReason`): another project opened while
 * it rendered is left alone, with a note saying so. A failed, blocked or
 * canceled export saves nothing. While it runs, Cancel stops it (main kills
 * ffmpeg and removes the partial file). Its notes (Reveal, failed, canceled,
 * save skipped) belong to the project that was open when they appeared, and
 * go away once another project is opened.
 */
export function ExportButton(): JSX.Element {
  const project = useProject((s) => s.project)
  const clipCount = project?.layers.filter((l) => l.content.kind === 'video').length ?? 0
  const preset = project?.preset ?? 'reel'
  const exportJob = useEditor((s) => latestJob(s.jobs, 'export'))
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSkipped, setSaveSkipped] = useState<string | null>(null)
  const [canceled, setCanceled] = useState(false)
  // The project the notes were posted for: they hide once another one is open.
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const showNotes = !busy && notesFor !== null && notesFor === project?.id

  const run = async (): Promise<void> => {
    if (!project || clipCount === 0 || busy) return
    setBusy(true)
    setOutput(null)
    setError(null)
    setSaveError(null)
    setSaveSkipped(null)
    setCanceled(false)
    const origin: ExportOrigin = { id: project.id, filePath: useProject.getState().filePath }
    try {
      const path = await exportProject(project, { preset, preferNvenc: true })
      if (!path) return // Save dialog canceled
      setOutput(path)
      // The export is done either way; a skipped or failed save only adds a note beside Reveal.
      const skip = exportSaveSkipReason(origin, useProject.getState())
      if (skip) {
        setSaveSkipped(skip)
        return
      }
      await useProject
        .getState()
        .save()
        .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)))
    } catch (e) {
      // A canceled run rejects too; the job's own status says which it was.
      const msg = e instanceof Error ? e.message : String(e)
      if (latestJob(useEditor.getState().jobs, 'export')?.status === 'canceled' || msg.includes('Export canceled')) {
        setCanceled(true)
      }
      else setError(msg)
    } finally {
      setNotesFor(useProject.getState().project?.id ?? null)
      setBusy(false)
    }
  }

  const pct = Math.round((exportJob?.progress ?? 0) * 100)

  return (
    <div className="flex items-center gap-2">
      {output && showNotes && (
        <button
          onClick={() => void revealFile(output)}
          className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30"
          title={output}
        >
          ✓ Reveal export
        </button>
      )}
      {output && saveError && showNotes && (
        <span className="max-w-[260px] truncate text-xs text-amber-400" title={saveError} data-testid="export-save-error">
          Couldn't save the project: {saveError}
        </span>
      )}
      {output && saveSkipped && showNotes && (
        <span className="max-w-[260px] truncate text-xs text-amber-400" title={saveSkipped} data-testid="export-save-skipped">
          {saveSkipped}
        </span>
      )}
      {canceled && showNotes && (
        <span className="text-xs text-zinc-400" data-testid="export-canceled">
          Export canceled
        </span>
      )}
      {error && showNotes && (
        <span className="max-w-[260px] truncate text-xs text-rose-400" title={error}>
          Export failed: {error}
        </span>
      )}
      <button
        onClick={run}
        disabled={busy || clipCount === 0}
        className="rounded-md bg-sky-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        title={clipCount === 0 ? 'Add a clip to the timeline first' : `Export ${presetFor(preset).name}`}
      >
        {busy ? `Exporting… ${pct}%` : 'Export'}
      </button>
      {busy && exportJob && <CancelJobButton job={exportJob} className="py-1 text-xs" />}
    </div>
  )
}
