import { useState, type JSX } from 'react'
import type { LayoutContent } from '@shared/project'
import { layoutPreset } from '@shared/layouts'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { ClipCard } from './ClipCard'
import { LayoutPickerModal } from './LayoutPickerModal'
import { inputCls, NumberInput } from './ui'

/** Matches the Library drag payload and the Timeline's `DND_MIME`. */
const DND_MIME = 'application/x-reel-asset'

/**
 * Per-cell editor for a selected layout layer (lives in the Inspector's Layout
 * section). Each cell:
 *  - a picker to assign / change / clear its clip,
 *  - a DROP TARGET — drag a library clip onto the cell to assign it (overwriting
 *    whatever was there), matching the timeline's drag payload,
 *  - the shared `ClipCard` preview (thumbnail + hover screen, no add-to-timeline)
 *    with trim + mute once a clip is assigned.
 * All edits go through `updateLayoutCell` (one undo step each); geometry the
 * preview/export use resolves through `shared/layouts.ts`.
 */
export function LayoutCells({
  layerId,
  content
}: {
  layerId: string
  content: LayoutContent
}): JSX.Element {
  const { data: assets = [] } = useLibrary()
  const updateCell = useProject((s) => s.updateLayoutCell)
  const setLayoutPreset = useProject((s) => s.setLayoutPreset)
  const convertCellToComp = useProject((s) => s.convertCellToComp)
  const enterComposition = useProject((s) => s.enterComposition)
  const [dropCell, setDropCell] = useState<number | null>(null)
  const [reshapeOpen, setReshapeOpen] = useState(false)
  const videoAssets = assets.filter((a) => a.probe.video)
  const preset = layoutPreset(content.presetId)

  /**
   * "Edit panel": open this cell as its own timeline. A plain clip is converted
   * to a composition seeded with it first (one undo step), then the editor
   * steps in — from there every normal tool (cut, audio, color, text, even
   * another layout) applies to the panel's own sub-timeline.
   */
  const editCell = (i: number): void => {
    if (!content.cells[i]?.comp) convertCellToComp(layerId, i)
    enterComposition({ layerId, cellIndex: i })
  }

  // Assign (overwriting) a clip to a cell, seeding the trim to its full source.
  const assign = (i: number, mediaId: string): void => {
    const src = assets.find((a) => a.id === mediaId)
    if (!src || !src.probe.video) return // cells host video
    updateCell(layerId, i, { mediaId, inSec: 0, outSec: Math.max(0.1, src.probe.durationSec) })
  }

  return (
    <>
      <button
        onClick={() => setReshapeOpen(true)}
        title="Change the layout arrangement"
        className="mb-2 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
      >
        ▦ Change layout · {preset.label}
      </button>

      <ul className="space-y-2">
      {content.cells.map((cell, i) => {
        const cellAsset = cell.mediaId ? assets.find((a) => a.id === cell.mediaId) : undefined
        const over = dropCell === i
        return (
          <li
            key={i}
            data-testid={`layout-cell-${i}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DND_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              if (dropCell !== i) setDropCell(i)
            }}
            onDragLeave={(e) => {
              // Only clear when the drag truly leaves the cell — not when it
              // crosses between the cell's own children (select / card).
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDropCell((c) => (c === i ? null : c))
              }
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DND_MIME)
              setDropCell(null)
              if (!id) return
              e.preventDefault()
              e.stopPropagation()
              assign(i, id)
            }}
            className={`rounded-lg p-1.5 transition ${
              over ? 'bg-sky-400/15 ring-2 ring-sky-400/60' : 'bg-white/[0.03]'
            }`}
          >
            <div className="mb-1 flex items-center gap-1.5 px-0.5">
              <span className="text-[10px] font-semibold text-zinc-400">Cell {i + 1}</span>
              {cell.comp ? (
                <span className="flex-1 truncate text-[10px] text-fuchsia-300">
                  🧩 Nested timeline
                </span>
              ) : (
                <select
                  value={cell.mediaId ?? ''}
                  onChange={(e) => {
                    const mediaId = e.target.value || null
                    if (mediaId) assign(i, mediaId)
                    else updateCell(layerId, i, { mediaId: null })
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
              )}
              <button
                onClick={() => editCell(i)}
                className="shrink-0 rounded bg-fuchsia-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-200 hover:bg-fuchsia-500/40"
                title={
                  cell.comp
                    ? 'Open this panel as its own timeline'
                    : 'Edit this panel as its own timeline — cut it, add audio, colour it, layer text over it'
                }
              >
                ✎ Edit
              </button>
            </div>

            {cell.comp ? (
              <div className="px-1 pb-1">
                <p className="text-[10px] leading-snug text-zinc-500">
                  This panel is its own timeline. Press{' '}
                  <span className="text-fuchsia-300">✎ Edit</span> to open it; changes appear in the
                  panel live.
                </p>
                {/* Master mute for the panel. A comp mixes its own audio, so
                    this sits ABOVE those choices — it silences the whole
                    nested timeline, lane and clips alike (the export skips a
                    muted cell's audio the same way). */}
                <label className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={cell.mute}
                    onChange={() => updateCell(layerId, i, { mute: !cell.mute })}
                  />
                  mute this panel
                </label>
              </div>
            ) : cellAsset ? (
              <ClipCard
                asset={cellAsset}
                footer={
                  <div className="mt-1.5 flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="w-6 shrink-0 text-[10px] text-zinc-500">in</span>
                      <NumberInput
                        step={0.1}
                        min={0}
                        max={cell.outSec - 0.1}
                        value={cell.inSec}
                        format={(v) => v.toFixed(1)}
                        onCommit={(inSec) => updateCell(layerId, i, { inSec })}
                        className={`${inputCls} min-w-0 flex-1`}
                        title="Source in-point (s)"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-6 shrink-0 text-[10px] text-zinc-500">out</span>
                      <NumberInput
                        step={0.1}
                        min={cell.inSec + 0.1}
                        max={cellAsset.probe.durationSec}
                        value={cell.outSec}
                        format={(v) => v.toFixed(1)}
                        onCommit={(outSec) => updateCell(layerId, i, { outSec })}
                        className={`${inputCls} min-w-0 flex-1`}
                        title="Source out-point (s)"
                      />
                    </div>
                    <label className="flex items-center gap-1 text-[10px] text-zinc-400">
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
                Drag a clip here (or pick one above). Empty — lower layers show through this panel.
              </p>
            )}
          </li>
        )
      })}
      </ul>

      <LayoutPickerModal
        open={reshapeOpen}
        title="Change arrangement"
        activePresetId={content.presetId}
        onPick={(presetId) => {
          setLayoutPreset(layerId, presetId)
          setReshapeOpen(false)
        }}
        onClose={() => setReshapeOpen(false)}
      />
    </>
  )
}
