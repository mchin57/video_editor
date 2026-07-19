import { useEffect, useRef, useState, type JSX } from 'react'
import type { LayoutContent } from '@shared/project'
import type { PresetId } from '@shared/export'
import { EXPORT_PRESETS } from '@shared/export'
import { layoutPreset } from '@shared/layouts'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { thumbUrl } from '@/ipc/client'
import { ClipCard } from './ClipCard'
import { LayoutPresetPreview } from './LayoutPresetPreview'
import { LayoutPickerModal } from './LayoutPickerModal'
import { Field, inputCls } from './ui'

/**
 * FORMAT menu (header bar, next to File / View): how the frame is shaped and
 * divided — the project's aspect ratio (moved here from Project settings) and
 * the multi-clip layout tools. "Add layout" opens a visual preset picker; a
 * selected layout shows a live preview of its arrangement plus a card per cell.
 * Mirrors FileMenu's open/click-outside pattern.
 */
export function FormatMenu(): JSX.Element | null {
  const hasProject = useProject((s) => !!s.project)
  const preset = useProject((s) => s.project?.preset ?? 'reel')
  const setPreset = useProject((s) => s.setPreset)
  const addLayoutLayer = useProject((s) => s.addLayoutLayer)
  const setLayoutPreset = useProject((s) => s.setLayoutPreset)
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectedLayout = useProject((s) => {
    const l = s.project?.layers.find((x) => x.id === selectedLayerId)
    return l && l.content.kind === 'layout' ? l : null
  })

  const [open, setOpen] = useState(false)
  // The visual picker: 'add' creates a new layout, 'reshape' re-presets the
  // selected one. null = closed.
  const [picker, setPicker] = useState<'add' | 'reshape' | null>(null)
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

  const layoutContent = selectedLayout?.content as LayoutContent | undefined

  const onPick = (presetId: string): void => {
    if (picker === 'add') {
      const id = crypto.randomUUID()
      addLayoutLayer(id, presetId, usePlayback.getState().time)
      useUi.getState().selectLayer(id)
    } else if (picker === 'reshape' && selectedLayout) {
      setLayoutPreset(selectedLayout.id, presetId)
    }
    setPicker(null)
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
          className="absolute left-0 top-full z-50 mt-1 max-h-[75vh] w-80 overflow-y-auto rounded-lg border border-white/10 bg-zinc-900 p-3 shadow-2xl"
        >
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
            onClick={() => {
              setPicker('add')
              setOpen(false)
            }}
            className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            title="Add a multi-clip layout (split screen / panels) at the playhead"
          >
            ▦ Add layout at playhead
          </button>

          {selectedLayout && layoutContent ? (
            <div className="mt-2">
              <LayoutCellControls
                layerId={selectedLayout.id}
                content={layoutContent}
                aspect={EXPORT_PRESETS[preset].width / EXPORT_PRESETS[preset].height}
                onReshape={() => {
                  setPicker('reshape')
                  setOpen(false)
                }}
              />
            </div>
          ) : (
            <p className="mt-2 text-[10px] leading-snug text-zinc-500">
              Select a layout block on the timeline to change its arrangement and fill its cells.
            </p>
          )}
        </div>
      )}

      <LayoutPickerModal
        open={picker !== null}
        title={picker === 'reshape' ? 'Change arrangement' : 'Choose a layout'}
        activePresetId={picker === 'reshape' ? layoutContent?.presetId : undefined}
        onPick={onPick}
        onClose={() => setPicker(null)}
      />
    </div>
  )
}

/** The selected layout's live preview (click to reshape) + a card per cell.
 *  Each assigned cell renders the shared `ClipCard` (thumbnail + hover preview,
 *  NO add-to-timeline — the clip is already in the layout), with a picker to
 *  change/clear it and trim + mute in its footer. */
function LayoutCellControls({
  layerId,
  content,
  aspect,
  onReshape
}: {
  layerId: string
  content: LayoutContent
  aspect: number
  onReshape: () => void
}): JSX.Element {
  const { data: assets = [] } = useLibrary()
  const updateCell = useProject((s) => s.updateLayoutCell)
  const videoAssets = assets.filter((a) => a.probe.video)
  const preset = layoutPreset(content.presetId)

  return (
    <>
      {/* Live preview of the arrangement — click to reshape via the picker. */}
      <button
        onClick={onReshape}
        title="Change the arrangement"
        className="mb-2 flex w-full flex-col items-center gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-2 hover:border-white/25 hover:bg-white/5"
      >
        <LayoutPresetPreview
          preset={preset}
          aspect={aspect}
          height={120}
          thumb={(i) => {
            const mediaId = content.cells[i]?.mediaId
            if (!mediaId) return null
            return <img src={thumbUrl(mediaId)} alt="" className="h-full w-full object-cover" />
          }}
        />
        <span className="text-[10px] font-medium text-zinc-400">{preset.label} · change ▾</span>
      </button>

      <ul className="space-y-2">
        {content.cells.map((cell, i) => {
          const cellAsset = cell.mediaId ? assets.find((a) => a.id === cell.mediaId) : undefined
          return (
            <li key={i} className="rounded-lg bg-white/[0.03] p-1.5">
              <div className="mb-1 flex items-center gap-1.5 px-0.5">
                <span className="text-[10px] font-semibold text-zinc-400">Cell {i + 1}</span>
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

              {cellAsset ? (
                <ClipCard
                  asset={cellAsset}
                  footer={
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500">in</span>
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
                        className={`${inputCls} w-12 flex-none`}
                        title="Source in-point (s)"
                      />
                      <span className="text-[10px] text-zinc-500">out</span>
                      <input
                        type="number"
                        step={0.1}
                        value={cell.outSec.toFixed(1)}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) {
                            const cap = cellAsset.probe.durationSec
                            updateCell(layerId, i, { outSec: Math.max(cell.inSec + 0.1, Math.min(v, cap)) })
                          }
                        }}
                        className={`${inputCls} w-12 flex-none`}
                        title="Source out-point (s)"
                      />
                      <label className="ml-auto flex items-center gap-1 text-[10px] text-zinc-400">
                        <input
                          type="checkbox"
                          checked={cell.mute}
                          onChange={() => updateCell(layerId, i, { mute: !cell.mute })}
                        />
                        mute
                      </label>
                    </div>
                  }
                />
              ) : (
                <p className="px-1 pb-1 text-[10px] text-zinc-600">
                  Empty — lower layers show through this panel.
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Cells fill their panel (center-cropped) and play at 1× from the layout&apos;s start. A cell
        disappears when its clip ends.
      </p>
    </>
  )
}
