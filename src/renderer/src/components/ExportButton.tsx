import { useState, type JSX } from 'react'
import { useProject } from '@/state/projectStore'
import { useEditor } from '@/state/store'
import { exportProject, revealFile } from '@/ipc/client'

/**
 * Exports the current timeline to a 1080x1920 Reel .mp4 (NVENC when available).
 * Shows live progress from the export job, then a Reveal action on success.
 */
export function ExportButton(): JSX.Element {
  const project = useProject((s) => s.project)
  const clipCount = project?.clips.length ?? 0
  const exportJob = useEditor((s) => s.exportJob)
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (!project || clipCount === 0 || busy) return
    setBusy(true)
    setOutput(null)
    setError(null)
    try {
      const path = await exportProject(project, { preset: 'reel', preferNvenc: true })
      setOutput(path)
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
      {error && !busy && (
        <span className="max-w-[260px] truncate text-xs text-rose-400" title={error}>
          Export failed: {error}
        </span>
      )}
      <button
        onClick={run}
        disabled={busy || clipCount === 0}
        className="rounded-md bg-sky-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        title={clipCount === 0 ? 'Add a clip to the timeline first' : 'Export a 1080×1920 Reel'}
      >
        {busy ? `Exporting… ${pct}%` : 'Export Reel'}
      </button>
    </div>
  )
}
