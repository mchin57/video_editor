import { type JSX } from 'react'
import { createPortal } from 'react-dom'
import { LAYOUT_PRESETS } from '@shared/layouts'
import { projectFormat, useProject } from '@/state/projectStore'
import { LayoutPresetPreview } from './LayoutPresetPreview'

/**
 * Visual layout picker: a gallery of every built-in preset rendered as a
 * mini-frame at the project's CURRENT aspect ratio (so Split L|R shows a line
 * down the middle, etc.), driven off `LAYOUT_PRESETS` so future presets appear
 * automatically. Clicking one calls `onPick(presetId)`.
 *
 * Used both to ADD a layout (`onPick` creates one) and to RESHAPE the selected
 * layout (`onPick` = setLayoutPreset); `activePresetId` highlights the current
 * arrangement in the reshape case. Portaled to <body>, closes on backdrop click.
 */
export function LayoutPickerModal({
  open,
  title,
  activePresetId,
  onPick,
  onClose
}: {
  open: boolean
  title: string
  activePresetId?: string
  onPick: (presetId: string) => void
  onClose: () => void
}): JSX.Element | null {
  const target = useProject(projectFormat)
  if (!open) return null
  const aspect = target.width / target.height

  return createPortal(
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 p-8" onClick={onClose}>
      <div
        data-testid="layout-picker"
        className="max-h-full w-[560px] max-w-full overflow-y-auto rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <span className="text-[10px] text-zinc-500">{target.name}</span>
        </div>
        <p className="mb-4 text-[11px] text-zinc-500">
          Each option is drawn at your current aspect ratio. Pick an arrangement to{' '}
          {activePresetId ? 'reshape this layout' : 'add it at the playhead'}.
        </p>

        <div className="grid grid-cols-3 gap-3">
          {LAYOUT_PRESETS.map((p) => {
            const active = p.id === activePresetId
            return (
              <button
                key={p.id}
                onClick={() => onPick(p.id)}
                title={`${p.label} (${p.rects.length} cells)`}
                className={`flex flex-col items-center gap-1.5 rounded-lg border p-2 transition ${
                  active
                    ? 'border-fuchsia-400/60 bg-fuchsia-400/10'
                    : 'border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/5'
                }`}
              >
                <LayoutPresetPreview preset={p} aspect={aspect} height={112} />
                <span className={`text-[10px] font-medium ${active ? 'text-fuchsia-200' : 'text-zinc-300'}`}>
                  {p.label}
                </span>
              </button>
            )
          })}
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body
  )
}
