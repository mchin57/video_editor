import { useEffect, useRef, useState, type JSX } from 'react'
import { DEFAULT_STABILIZE } from '@shared/project'
import type { PresetId } from '@shared/export'
import { EXPORT_PRESETS } from '@shared/export'
import { useProject } from '@/state/projectStore'
import { StabilizeSliders } from './Inspector'

/**
 * Project settings dropdown (next to the File menu): project-wide export
 * defaults — reduce noise, stabilize — plus the global caption visibility
 * toggle. Per-clip overrides still live in each clip's Inspector; this is only
 * the project-wide layer. Mirrors FileMenu's open/click-outside pattern.
 */
export function ProjectSettingsMenu(): JSX.Element | null {
  const hasProject = useProject((s) => !!s.project)
  const denoiseDefault = useProject((s) => s.project?.denoiseDefault ?? false)
  const setDenoiseDefault = useProject((s) => s.setDenoiseDefault)
  const stabilizeDefault = useProject((s) => s.project?.stabilizeDefault ?? null)
  const setStabilizeDefault = useProject((s) => s.setStabilizeDefault)
  const captions = useProject((s) => s.project?.captions)
  const setCaptions = useProject((s) => s.setCaptions)
  const preset = useProject((s) => s.project?.preset ?? 'reel')
  const setPreset = useProject((s) => s.setPreset)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!hasProject) return null

  const hasCaptions = !!captions && captions.segments.length > 0

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
      >
        Project settings ▾
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-white/10 bg-zinc-900 p-3 shadow-2xl">
          <div
            className="mb-1 text-xs text-zinc-300"
            title="Sets the preview shape and the exported output size."
          >
            Aspect ratio
          </div>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as PresetId)}
            title="Sets the preview shape and the exported output size."
            className="w-full rounded border border-white/10 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none"
          >
            {Object.values(EXPORT_PRESETS).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="my-2 h-px bg-white/10" />

          <label
            className="flex items-center gap-2 text-xs text-zinc-300"
            title="Applies FFT noise reduction to every audio clip on export. Individual clips can override this from their inspector; overridden clips show an N badge on the timeline."
          >
            <input
              type="checkbox"
              checked={denoiseDefault}
              onChange={(e) => setDenoiseDefault(e.target.checked)}
            />
            Reduce noise by default (all audio clips)
          </label>

          <div className="my-2 h-px bg-white/10" />

          <label
            className="flex items-center gap-2 text-xs text-zinc-300"
            title="Runs a two-pass stabilize on every video clip on export. Individual clips can override this from their inspector; overridden clips show an S badge on the timeline."
          >
            <input
              type="checkbox"
              checked={!!stabilizeDefault}
              onChange={(e) => setStabilizeDefault(e.target.checked ? { ...DEFAULT_STABILIZE } : null)}
            />
            Stabilize by default (all video clips)
          </label>
          {stabilizeDefault && <StabilizeSliders value={stabilizeDefault} onChange={setStabilizeDefault} />}

          <div className="my-2 h-px bg-white/10" />

          <label
            className={`flex items-center gap-2 text-xs ${hasCaptions ? 'text-zinc-300' : 'text-zinc-600'}`}
            title={hasCaptions ? 'Show / hide captions' : 'Caption a clip first to enable this'}
          >
            <input
              type="checkbox"
              checked={hasCaptions && !!captions?.enabled}
              disabled={!hasCaptions}
              onChange={(e) => captions && setCaptions({ ...captions, enabled: e.target.checked })}
            />
            Show captions
          </label>
        </div>
      )}
    </div>
  )
}
