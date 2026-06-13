import type { JSX, ReactNode } from 'react'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { useEditor } from '@/state/store'
import { formatDuration, formatFps } from '@/lib/format'
import { clipDuration } from '@/lib/timeline'
import { hookCovered } from '@/lib/overlays'

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-2 py-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-300">{children}</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-400/60'

function OverlayEditor(): JSX.Element | null {
  const selectedOverlayId = useUi((s) => s.selectedOverlayId)
  const overlay = useProject((s) => s.project?.overlays.find((o) => o.id === selectedOverlayId) ?? null)
  const update = useProject((s) => s.updateOverlay)
  const remove = useProject((s) => s.removeOverlay)
  const selectOverlay = useUi((s) => s.selectOverlay)
  if (!overlay) return null

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-200">Text overlay</div>
      <Field label="Text">
        <textarea
          value={overlay.text}
          rows={2}
          onChange={(e) => update(overlay.id, { text: e.target.value })}
          className={inputCls}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="Start (s)">
          <input
            type="number"
            step="0.1"
            min="0"
            value={overlay.startSec.toFixed(1)}
            onChange={(e) => update(overlay.id, { startSec: Math.max(0, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="End (s)">
          <input
            type="number"
            step="0.1"
            value={overlay.endSec.toFixed(1)}
            onChange={(e) =>
              update(overlay.id, { endSec: Math.max(overlay.startSec + 0.2, Number(e.target.value)) })
            }
            className={inputCls}
          />
        </Field>
      </div>
      <div className="flex items-end gap-2">
        <Field label="Font size">
          <input
            type="number"
            step="2"
            min="12"
            value={overlay.fontSizePx}
            onChange={(e) => update(overlay.id, { fontSizePx: Math.max(12, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="Color">
          <input
            type="color"
            value={overlay.color}
            onChange={(e) => update(overlay.id, { color: e.target.value })}
            className="h-7 w-full rounded border border-white/10 bg-black/40"
          />
        </Field>
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={overlay.pill.enabled}
          onChange={(e) => update(overlay.id, { pill: { ...overlay.pill, enabled: e.target.checked } })}
        />
        Background pill
      </label>
      <button
        onClick={() => {
          remove(overlay.id)
          selectOverlay(null)
        }}
        className="w-full rounded bg-rose-500/20 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/30"
      >
        Delete overlay
      </button>
    </div>
  )
}

function ClipDetails(): JSX.Element {
  const selectedClipId = useProject((s) => s.selectedClipId)
  const clip = useProject((s) => s.project?.clips.find((c) => c.id === selectedClipId) ?? null)
  const setClipCrop = useProject((s) => s.setClipCrop)
  const setCropEditing = useUi((s) => s.setCropEditing)
  const { data: assets = [] } = useLibrary()
  const libSelectedId = useEditor((s) => s.selectedId)

  // Fall back to the library selection so importing still shows source info.
  const asset = clip
    ? assets.find((a) => a.id === clip.mediaId)
    : assets.find((a) => a.id === libSelectedId)

  if (!clip && !asset) {
    return <p className="text-sm text-zinc-600">Select a timeline clip to edit it.</p>
  }

  const v = asset?.probe.video
  return (
    <>
      <div className="mb-2 truncate text-sm font-medium text-zinc-200" title={asset?.fileName}>
        {asset?.fileName ?? 'Clip'}
      </div>
      <div className="divide-y divide-white/5">
        {clip && <Row label="On timeline">{clipDuration(clip).toFixed(1)}s</Row>}
        {clip && (
          <Row label="Trim">
            {clip.inSec.toFixed(1)}–{clip.outSec.toFixed(1)}s
          </Row>
        )}
        {v && <Row label="Source">{`${v.codec} · ${v.displayWidth}×${v.displayHeight}`}</Row>}
        {v && <Row label="Frame rate">{formatFps(v.avgFps)}</Row>}
        {v && <Row label="HDR">{v.isHdr ? `yes (${v.colorTransfer})` : 'no'}</Row>}
        {asset && <Row label="Duration">{formatDuration(asset.probe.durationSec)}</Row>}
        {clip && <Row label="Crop">{clip.crop ? '9:16 set' : 'full frame'}</Row>}
      </div>

      {clip && (
        <div className="mt-3 flex flex-col gap-2">
          <button
            onClick={() => setCropEditing(true)}
            className="rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
          >
            {clip.crop ? 'Edit crop' : 'Crop to 9:16'}
          </button>
          {clip.crop && (
            <button
              onClick={() => setClipCrop(clip.id, null)}
              className="rounded bg-white/5 px-2 py-1.5 text-xs text-zinc-400 hover:bg-white/10"
            >
              Remove crop
            </button>
          )}
        </div>
      )}
    </>
  )
}

export function Inspector(): JSX.Element {
  const selectedOverlayId = useUi((s) => s.selectedOverlayId)
  const overlays = useProject((s) => s.project?.overlays)
  const hookOk = hookCovered(overlays ?? [])

  return (
    <div className="flex h-full w-64 flex-col">
      <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Inspector
      </div>

      {/* Hook rule indicator */}
      <div
        className={`flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5 text-[11px] ${
          hookOk ? 'text-emerald-400' : 'text-amber-400'
        }`}
        title="Instagram: get your hook text on screen in the first 3 seconds"
      >
        <span>{hookOk ? '✓' : '⚠'}</span>
        {hookOk ? 'Hook text in first 3s' : 'No hook text in first 3s'}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selectedOverlayId ? <OverlayEditor /> : <ClipDetails />}
      </div>
    </div>
  )
}
