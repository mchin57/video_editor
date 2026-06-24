import { useState, type JSX } from 'react'
import type { PresetId } from '@shared/export'
import { EXPORT_PRESETS } from '@shared/export'
import { useProject } from '@/state/projectStore'
import { useEditor } from '@/state/store'
import { exportProject, revealFile } from '@/ipc/client'

/**
 * Exports the current timeline to the selected preset (.mp4, NVENC when
 * available). Shows live progress, then a Reveal action on success.
 */
export function ExportButton(): JSX.Element {
  const project = useProject((s) => s.project)
  const clipCount = project?.layers.filter((l) => l.content.kind === 'video').length ?? 0
  const preset = project?.preset ?? 'reel'
  const setPreset = useProject((s) => s.setPreset)
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
      const path = await exportProject(project, { preset, preferNvenc: true })
      if (path) setOutput(path) // null = Save dialog canceled
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
      {!busy && (
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as PresetId)}
          className="rounded-md border border-white/10 bg-zinc-800 px-1.5 py-1 text-xs text-zinc-200 outline-none"
          title="Export preset"
        >
          {Object.values(EXPORT_PRESETS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={run}
        disabled={busy || clipCount === 0}
        className="rounded-md bg-sky-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
        title={clipCount === 0 ? 'Add a clip to the timeline first' : `Export ${EXPORT_PRESETS[preset].name}`}
      >
        {busy ? `Exporting… ${pct}%` : 'Export'}
      </button>
    </div>
  )
}
