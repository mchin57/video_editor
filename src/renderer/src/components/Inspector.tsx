import { useRef, useState, type JSX, type ReactNode } from 'react'
import type { Project } from '@shared/project'
import { NEUTRAL_COLOR, effectiveOut, isNeutralColor } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { detectSilence } from '@/ipc/client'
import { speechSegments } from '@/lib/silence'
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

/** Color slider: live updates during drag, one undo step on release. */
function ColorSlider({
  clipId,
  prop,
  min,
  max,
  value
}: {
  clipId: string
  prop: 'brightness' | 'contrast' | 'saturation'
  min: number
  max: number
  value: number
}): JSX.Element {
  const before = useRef<Project | null>(null)
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={0.02}
      value={value}
      onPointerDown={() => (before.current = useProject.getState().project)}
      onChange={(e) => {
        const v = Number(e.target.value)
        useProject.getState().liveUpdate((p) => ({
          ...p,
          clips: p.clips.map((c) =>
            c.id === clipId ? { ...c, color: { ...(c.color ?? NEUTRAL_COLOR), [prop]: v } } : c
          )
        }))
      }}
      onPointerUp={() => before.current && useProject.getState().commitLive(before.current)}
      className="w-full accent-sky-400"
    />
  )
}

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
  const setClipColor = useProject((s) => s.setClipColor)
  const extractClipAudio = useProject((s) => s.extractClipAudio)
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
          {asset?.probe.audio && (
            <button
              onClick={() => extractClipAudio(clip.id)}
              className="rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
              title="Move this clip's audio onto the audio track and mute the clip"
            >
              ♪ Extract audio
            </button>
          )}
        </div>
      )}

      {clip && (
        <div className="mt-3 border-t border-white/5 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Color</span>
            {!isNeutralColor(clip.color) && (
              <button
                onClick={() => setClipColor(clip.id, null)}
                className="text-[10px] text-zinc-400 hover:text-zinc-200"
              >
                Reset
              </button>
            )}
          </div>
          {(() => {
            const col = clip.color ?? NEUTRAL_COLOR
            return (
              <>
                <Field label={`Exposure  ${col.brightness >= 0 ? '+' : ''}${col.brightness.toFixed(2)}`}>
                  <ColorSlider clipId={clip.id} prop="brightness" min={-0.5} max={0.5} value={col.brightness} />
                </Field>
                <Field label={`Contrast  ${col.contrast.toFixed(2)}`}>
                  <ColorSlider clipId={clip.id} prop="contrast" min={0.5} max={1.8} value={col.contrast} />
                </Field>
                <Field label={`Saturation  ${col.saturation.toFixed(2)}`}>
                  <ColorSlider clipId={clip.id} prop="saturation" min={0} max={2} value={col.saturation} />
                </Field>
              </>
            )
          })()}
        </div>
      )}
    </>
  )
}

function CaptionEditor(): JSX.Element | null {
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const seg = useProject(
    (s) => s.project?.captions.segments.find((c) => c.id === selectedCaptionId) ?? null
  )
  const update = useProject((s) => s.updateCaption)
  const remove = useProject((s) => s.removeCaption)
  const selectCaption = useUi((s) => s.selectCaption)
  if (!seg) return null

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-200">Caption</div>
      <Field label="Text">
        <textarea
          value={seg.text}
          rows={2}
          onChange={(e) => update(seg.id, { text: e.target.value })}
          className={inputCls}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="Start (s)">
          <input
            type="number"
            step="0.1"
            min="0"
            value={seg.startSec.toFixed(1)}
            onChange={(e) => update(seg.id, { startSec: Math.max(0, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="End (s)">
          <input
            type="number"
            step="0.1"
            value={seg.endSec.toFixed(1)}
            onChange={(e) =>
              update(seg.id, { endSec: Math.max(seg.startSec + 0.1, Number(e.target.value)) })
            }
            className={inputCls}
          />
        </Field>
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={seg.enabled}
          onChange={(e) => update(seg.id, { enabled: e.target.checked })}
        />
        Show this caption
      </label>
      <button
        onClick={() => {
          remove(seg.id)
          selectCaption(null)
        }}
        className="w-full rounded bg-rose-500/20 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/30"
      >
        Delete caption
      </button>
    </div>
  )
}

function AudioClipEditor(): JSX.Element | null {
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const clip = useProject((s) => s.project?.audioClips.find((a) => a.id === selectedAudioId) ?? null)
  const update = useProject((s) => s.updateAudioClip)
  const remove = useProject((s) => s.removeAudioClip)
  const splitOnSilence = useProject((s) => s.splitAudioOnSilence)
  const selectAudio = useUi((s) => s.selectAudio)
  const { data: assets = [] } = useLibrary()
  const [splitting, setSplitting] = useState(false)
  const [splitNote, setSplitNote] = useState<string | null>(null)
  if (!clip) return null
  const asset = assets.find((a) => a.id === clip.mediaId)

  const runSplitOnSilence = async (): Promise<void> => {
    if (splitting) return
    setSplitting(true)
    setSplitNote(null)
    try {
      const dur = asset?.probe.durationSec ?? clip.outSec
      const silences = await detectSilence(clip.mediaId)
      const ranges = speechSegments(silences, clip.inSec, effectiveOut(clip, dur), 0.4)
      if (ranges.length > 1) splitOnSilence(clip.id, ranges)
      else setSplitNote('No silence gaps found to split on.')
    } finally {
      setSplitting(false)
    }
  }

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200">Audio clip</div>
      <div className="mb-3 truncate text-xs text-zinc-400" title={asset?.fileName}>
        {asset?.fileName ?? clip.mediaId} · {clip.kind}
      </div>
      <Field label={`Volume · ${clip.gainDb} dB`}>
        <input
          type="range"
          min={-40}
          max={6}
          step={1}
          value={clip.gainDb}
          onChange={(e) => update(clip.id, { gainDb: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
      <Field label="Start (s)">
        <input
          type="number"
          step="0.1"
          min="0"
          value={clip.startSec.toFixed(1)}
          onChange={(e) => update(clip.id, { startSec: Math.max(0, Number(e.target.value)) })}
          className={inputCls}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="Fade in (s)">
          <input
            type="number"
            step="0.5"
            min="0"
            value={clip.fadeInSec}
            onChange={(e) => update(clip.id, { fadeInSec: Math.max(0, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="Fade out (s)">
          <input
            type="number"
            step="0.5"
            min="0"
            value={clip.fadeOutSec}
            onChange={(e) => update(clip.id, { fadeOutSec: Math.max(0, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
      </div>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={clip.duck}
          onChange={(e) => update(clip.id, { duck: e.target.checked })}
        />
        Duck under other audio (music bed)
      </label>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={!!clip.denoise}
          onChange={(e) => update(clip.id, { denoise: e.target.checked })}
        />
        Reduce noise (on export)
      </label>

      <button
        onClick={() => void runSplitOnSilence()}
        disabled={splitting}
        className="mb-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50"
        title="Detect silence and split this clip into its speech segments"
      >
        {splitting ? 'Detecting…' : '✂ Split on silence'}
      </button>
      {splitNote && <p className="mb-2 text-[11px] text-zinc-500">{splitNote}</p>}

      <button
        onClick={() => {
          remove(clip.id)
          selectAudio(null)
        }}
        className="mt-2 w-full rounded bg-rose-500/20 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/30"
      >
        Remove audio clip
      </button>
    </div>
  )
}

export function Inspector(): JSX.Element {
  const selectedOverlayId = useUi((s) => s.selectedOverlayId)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const overlays = useProject((s) => s.project?.overlays)
  const hookOk = hookCovered(overlays ?? [])

  return (
    <div className="flex h-full w-full flex-col">
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
        {selectedOverlayId ? (
          <OverlayEditor />
        ) : selectedCaptionId ? (
          <CaptionEditor />
        ) : selectedAudioId ? (
          <AudioClipEditor />
        ) : (
          <ClipDetails />
        )}
      </div>
    </div>
  )
}
