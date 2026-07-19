import { useEffect, useRef, useState, type JSX } from 'react'
import type { LayoutContent } from '@shared/project'
import type { PresetId } from '@shared/export'
import { EXPORT_PRESETS } from '@shared/export'
import { LAYOUT_PRESETS } from '@shared/layouts'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { Field, inputCls } from './ui'

/**
 * FORMAT menu (header bar, next to File / View): how the frame is shaped and
 * divided — the project's aspect ratio (moved here from Project settings) and
 * the multi-clip layout tools (add a layout; edit the selected layout's
 * arrangement and cells). Mirrors FileMenu's open/click-outside pattern.
 */
export function FormatMenu(): JSX.Element | null {
  const hasProject = useProject((s) => !!s.project)
  const preset = useProject((s) => s.project?.preset ?? 'reel')
  const setPreset = useProject((s) => s.setPreset)
  const addLayoutLayer = useProject((s) => s.addLayoutLayer)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectedLayout = useProject((s) => {
    const l = s.project?.layers.find((x) => x.id === selectedLayerId)
    return l && l.content.kind === 'layout' ? l : null
  })

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

  const addLayout = (): void => {
    const id = crypto.randomUUID()
    addLayoutLayer(id, LAYOUT_PRESETS[0].id, usePlayback.getState().time)
    useUi.getState().selectLayer(id)
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
        <div className="absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-white/10 bg-zinc-900 p-3 shadow-2xl">
          <Field label="Aspect ratio">
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as PresetId)}
              title="Sets the preview shape and the exported output size."
              className={inputCls}
            >
              {Object.values(EXPORT_PRESETS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="my-2 h-px bg-white/10" />

          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Multi-clip layout
          </div>
          <button
            onClick={addLayout}
            className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            title="Add a multi-clip layout (split screen / panels) at the playhead"
          >
            ▦ Add layout at playhead
          </button>
          {selectedLayout ? (
            <div className="mt-2">
              <LayoutControls
                layerId={selectedLayout.id}
                content={selectedLayout.content as LayoutContent}
              />
            </div>
          ) : (
            <p className="mt-2 text-[10px] leading-snug text-zinc-500">
              Select a layout block on the timeline to change its arrangement and fill its cells.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Multi-clip layout controls: pick the arrangement, then fill each cell with
 *  a clip from the project library (with its own trim + mute). All edits go
 *  through the layout store actions so each is one undo step; the geometry the
 *  preview/export use resolves through `shared/layouts.ts`. */
function LayoutControls({ layerId, content }: { layerId: string; content: LayoutContent }): JSX.Element {
  const { data: assets = [] } = useLibrary()
  const setPreset = useProject((s) => s.setLayoutPreset)
  const updateCell = useProject((s) => s.updateLayoutCell)
  const videoAssets = assets.filter((a) => a.probe.video)
  return (
    <>
      <Field label="Arrangement">
        <div className="flex flex-wrap gap-1">
          {LAYOUT_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(layerId, p.id)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                content.presetId === p.id
                  ? 'bg-fuchsia-500/40 text-fuchsia-100'
                  : 'bg-white/10 text-zinc-300 hover:bg-white/20'
              }`}
              title={`${p.label} (${p.rects.length} cells)`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      <ul className="mt-1.5 space-y-1.5">
        {content.cells.map((cell, i) => {
          const cellAsset = cell.mediaId ? assets.find((a) => a.id === cell.mediaId) : undefined
          return (
            <li key={i} className="rounded bg-white/5 px-1.5 py-1.5 text-[10px] text-zinc-300">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="font-semibold text-zinc-400">Cell {i + 1}</span>
                <select
                  value={cell.mediaId ?? ''}
                  onChange={(e) => {
                    const mediaId = e.target.value || null
                    const src = mediaId ? assets.find((a) => a.id === mediaId) : undefined
                    updateCell(layerId, i, {
                      mediaId,
                      inSec: 0,
                      outSec: src ? Math.max(0.1, src.probe.durationSec) : cell.outSec
                    })
                  }}
                  className={`${inputCls} min-w-0 flex-1`}
                  title="Clip shown in this cell"
                >
                  <option value="">— empty —</option>
                  {videoAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fileName}
                    </option>
                  ))}
                </select>
              </div>
              {cell.mediaId && (
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500">in</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={cell.inSec.toFixed(1)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) {
                        updateCell(layerId, i, { inSec: Math.max(0, Math.min(v, cell.outSec - 0.1)) })
                      }
                    }}
                    className={`${inputCls} w-14 flex-none`}
                    title="Source in-point (s)"
                  />
                  <span className="text-zinc-500">out</span>
                  <input
                    type="number"
                    step={0.1}
                    value={cell.outSec.toFixed(1)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) {
                        const cap = cellAsset ? cellAsset.probe.durationSec : v
                        updateCell(layerId, i, { outSec: Math.max(cell.inSec + 0.1, Math.min(v, cap)) })
                      }
                    }}
                    className={`${inputCls} w-14 flex-none`}
                    title="Source out-point (s)"
                  />
                  <label className="ml-auto flex items-center gap-1 text-zinc-400">
                    <input
                      type="checkbox"
                      checked={cell.mute}
                      onChange={() => updateCell(layerId, i, { mute: !cell.mute })}
                    />
                    mute
                  </label>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Cells fill their panel (center-cropped) and play at 1× from the layout&apos;s start. A cell
        disappears when its clip ends; empty areas show the layers underneath.
      </p>
    </>
  )
}
