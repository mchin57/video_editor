import { useState, type JSX } from 'react'
import { presetFor } from '@shared/formats'
import { useProject } from '@/state/projectStore'
import { latestJob, useEditor } from '@/state/store'
import { exportProject, revealFile } from '@/ipc/client'

/**
 * Exports the current timeline to the selected preset (.mp4, NVENC when
 * available). Shows live progress, then a Reveal action on success. A finished
 * export also saves the project (the store's `save`, exactly File > Save — so
 * edits made while it rendered are saved too); a failed, blocked or canceled
 * export saves nothing.
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

  const run = async (): Promise<void> => {
    if (!project || clipCount === 0 || busy) return
    setBusy(true)
    setOutput(null)
    setError(null)
    setSaveError(null)
    try {
      const path = await exportProject(project, { preset, preferNvenc: true })
      if (!path) return // Save dialog canceled
      setOutput(path)
      // The export is done either way; a failed save only adds a note beside Reveal.
      await useProject
        .getState()
        .save()
        .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pct = Math.round((exportJob?.progress ?? 0) * 100)

  return (
    <div className="flex items-center gap-2">
      {output && !busy && (
        <button
          onClick={() => void revealFile(output)}
          className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30"
          title={output}
        >
          ✓ Reveal export
        </button>
      )}
      {output && saveError && !busy && (
        <span className="max-w-[260px] truncate text-xs text-amber-400" title={saveError} data-testid="export-save-error">
          Couldn't save the project: {saveError}
        </span>
      )}
      {error && !busy && (
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
    </div>
  )
}
