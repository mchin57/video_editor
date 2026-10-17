import { useEffect, useRef, useState, type JSX } from 'react'
import { presetGroups, type PresetId } from '@shared/formats'
import { projectFormat, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { LayoutPickerModal } from './LayoutPickerModal'
import { Field, inputCls } from './ui'

/**
 * FORMAT menu (header bar, next to File / View): how the frame is shaped — the
 * project's aspect ratio (moved here from Project settings) and "Add layout",
 * which opens the visual preset picker and drops a new multi-clip layout at the
 * playhead. Filling a layout's panels + reshaping it live in the Inspector's
 * Layout section. Mirrors FileMenu's open/click-outside pattern.
 */
export function FormatMenu(): JSX.Element | null {
  const hasProject = useProject((s) => !!s.project)
  const current = useProject(projectFormat)
  const preset = current.id
  const setPreset = useProject((s) => s.setPreset)
  const addLayoutLayer = useProject((s) => s.addLayoutLayer)

  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
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

  const onPick = (presetId: string): void => {
    const id = crypto.randomUUID()
    addLayoutLayer(id, presetId, usePlayback.getState().time)
    useUi.getState().selectLayer(id)
    setPickerOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
      >
        Format ▾
      </button>

      {open && (
        <div
          data-testid="format-menu"
          className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-white/10 bg-zinc-900 p-3 shadow-2xl"
        >
          <Field label="Aspect ratio">
            <select
              data-testid="format-select"
              value={preset}
              onChange={(e) => setPreset(e.target.value as PresetId)}
              title="Sets the preview shape and the exported output size. Nothing on the timeline moves — whatever falls outside the frame is cropped on export and comes back if you switch again."
              className={inputCls}
            >
              {presetGroups().map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <p className="-mt-1 text-[10px] leading-snug text-zinc-500">
            {current.width} × {current.height}
            {current.hint ? ` · ${current.hint}` : ''}
          </p>

          <div className="my-2 h-px bg-white/10" />

          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Multi-clip layout</div>
          <button
            onClick={() => {
              setPickerOpen(true)
              setOpen(false)
            }}
            className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            title="Add a multi-clip layout (split screen / panels) at the playhead"
          >
            ▦ Add layout at playhead
          </button>
          <p className="mt-2 text-[10px] leading-snug text-zinc-500">
            Fill the panels and change the arrangement from the <span className="text-zinc-400">Inspector</span> once a
            layout is selected.
          </p>
        </div>
      )}

      <LayoutPickerModal
        open={pickerOpen}
        title="Choose a layout"
        onPick={onPick}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}
