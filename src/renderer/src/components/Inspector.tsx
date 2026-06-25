import { useRef, useState, type JSX, type ReactNode } from 'react'
import type { CaptionStyle, Layer, Project, VideoContent } from '@shared/project'
import { NEUTRAL_COLOR, effectiveCaptionStyle, effectiveOut, isNeutralColor } from '@shared/project'
import { hookCovered, videoSourceTime } from '@shared/layers'
import { useLibrary } from '@/hooks/useMedia'
import { detectSilence } from '@/ipc/client'
import { speechSegments } from '@/lib/silence'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { formatDuration, formatFps } from '@/lib/format'
import { CollapsibleSection } from './CollapsibleSection'

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

/** A range slider that previews live during the drag and records one undo step
 *  on release. `transform` maps (project, value) → next project. */
function LiveRange({
  min,
  max,
  step,
  value,
  transform
}: {
  min: number
  max: number
  step: number
  value: number
  transform: (p: Project, v: number) => Project
}): JSX.Element {
  const before = useRef<Project | null>(null)
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onPointerDown={() => (before.current = useProject.getState().project)}
      onChange={(e) => {
        const v = Number(e.target.value)
        useProject.getState().liveUpdate((p) => transform(p, v))
      }}
      onPointerUp={() => before.current && useProject.getState().commitLive(before.current)}
      className="w-full accent-sky-400"
    />
  )
}

const setLayer = (id: string) => (p: Project, fn: (l: Layer) => Layer): Project => ({
  ...p,
  layers: p.layers.map((l) => (l.id === id ? fn(l) : l))
})

/** Freeze-frame controls: hold the current frame for a chosen duration, and list
 *  existing holds. Adding a freeze extends only this clip (no ripple). */
function FreezeFrames({ layer, content }: { layer: Layer; content: VideoContent }): JSX.Element {
  const addFreeze = useProject((s) => s.addFreeze)
  const removeFreeze = useProject((s) => s.removeFreeze)
  const [hold, setHold] = useState(2)
  const freezes = content.freezes ?? []

  return (
    <div>
      <div className="mb-2 flex items-end gap-2">
        <Field label="Hold (s)">
          <input
            type="number"
            step="0.5"
            min="0.1"
            value={hold}
            onChange={(e) => setHold(Math.max(0.1, Number(e.target.value)))}
            className={inputCls}
          />
        </Field>
        <button
          onClick={() => addFreeze(layer.id, videoSourceTime(content, layer, usePlayback.getState().time), hold)}
          className="mb-2 flex-1 rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
          title="Hold the frame at the playhead for the chosen duration"
        >
          ⏸ Pause clip here
        </button>
      </div>
      {freezes.length === 0 ? (
        <p className="text-[11px] text-zinc-600">No freezes. Move the playhead and add one.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {freezes.map((f, i) => (
            <li key={i} className="flex items-center justify-between rounded bg-black/30 px-2 py-1 text-[11px] text-zinc-300">
              <span>
                @ {Math.max(0, f.atSec - content.inSec).toFixed(1)}s into clip · hold {f.holdSec.toFixed(1)}s
              </span>
              <button
                onClick={() => removeFreeze(layer.id, i)}
                className="rounded px-1 text-rose-300 hover:bg-rose-500/20"
                title="Remove this freeze"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LayerEditor(): JSX.Element | null {
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const layer = useProject((s) => s.project?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const update = useProject((s) => s.updateLayer)
  const updateContent = useProject((s) => s.updateLayerContent)
  const remove = useProject((s) => s.removeLayer)
  const extractAudio = useProject((s) => s.extractLayerAudio)
  const setCropEditing = useUi((s) => s.setCropEditing)
  const setStillsOpen = useUi((s) => s.setStillsOpen)
  const setImageEditOpen = useUi((s) => s.setImageEditOpen)
  const { data: assets = [] } = useLibrary()
  if (!layer) return null
  const id = layer.id
  const mut = setLayer(id)
  const c = layer.content
  const asset =
    c.kind === 'video' || c.kind === 'image' ? assets.find((a) => a.id === c.mediaId) : undefined
  const kindName = c.kind === 'video' ? 'Video layer' : c.kind === 'image' ? 'Image layer' : 'Text layer'

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200">{kindName}</div>
      {asset && (
        <div className="mb-2 truncate text-xs text-zinc-400" title={asset.fileName}>
          {asset.fileName}
        </div>
      )}

      <CollapsibleSection id="transform" title="Transform">
      <div className="flex gap-2">
        <Field label="Start (s)">
          <input
            type="number"
            step="0.1"
            min="0"
            value={layer.startSec.toFixed(1)}
            onChange={(e) => update(id, { startSec: Math.max(0, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="End (s)">
          <input
            type="number"
            step="0.1"
            value={layer.endSec.toFixed(1)}
            onChange={(e) => update(id, { endSec: Math.max(layer.startSec + 0.2, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
      </div>

      <div className="flex gap-2">
        <Field label="Position X">
          <input
            type="number"
            step="5"
            value={Math.round(layer.x)}
            onChange={(e) => update(id, { x: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
        <Field label="Position Y">
          <input
            type="number"
            step="5"
            value={Math.round(layer.y)}
            onChange={(e) => update(id, { y: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
      </div>

      <Field label={`Zoom · ${Math.round(layer.scale * 100)}%`}>
        <LiveRange
          min={0.05}
          max={4}
          step={0.01}
          value={layer.scale}
          transform={(p, v) => mut(p, (l) => ({ ...l, scale: v }))}
        />
      </Field>

      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={!layer.hidden} onChange={() => update(id, { hidden: !layer.hidden })} />
        Visible
      </label>
      </CollapsibleSection>

      {/* Video-specific controls */}
      {c.kind === 'video' && (
        <>
          <CollapsibleSection id="trim" title="Trim & audio">
          <div className="flex gap-2">
            <Field label="Trim in (s)">
              <input
                type="number"
                step="0.1"
                min="0"
                value={c.inSec.toFixed(1)}
                onChange={(e) =>
                  updateContent(id, { inSec: Math.max(0, Math.min(Number(e.target.value), c.outSec - 0.05)) })
                }
                className={inputCls}
              />
            </Field>
            <Field label="Trim out (s)">
              <input
                type="number"
                step="0.1"
                value={c.outSec.toFixed(1)}
                onChange={(e) => updateContent(id, { outSec: Math.max(c.inSec + 0.05, Number(e.target.value)) })}
                className={inputCls}
              />
            </Field>
          </div>
          {asset?.probe.video && (
            <Row label="Source">{`${asset.probe.video.displayWidth}×${asset.probe.video.displayHeight} · ${formatFps(asset.probe.video.avgFps)}`}</Row>
          )}
          {asset && <Row label="Duration">{formatDuration(asset.probe.durationSec)}</Row>}
          <label className="my-2 flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={c.mute} onChange={() => updateContent(id, { mute: !c.mute })} />
            Mute this layer
          </label>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setCropEditing(true)}
              className="rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            >
              {c.crop ? 'Edit crop' : 'Crop to 9:16'}
            </button>
            {c.crop && (
              <button
                onClick={() => updateContent(id, { crop: null })}
                className="rounded bg-white/5 px-2 py-1.5 text-xs text-zinc-400 hover:bg-white/10"
              >
                Remove crop
              </button>
            )}
            {asset?.probe.audio && (
              <button
                onClick={() => extractAudio(id)}
                className="rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
                title="Move this layer's audio onto the audio track and mute the layer"
              >
                ♪ Extract audio
              </button>
            )}
          </div>
          <button
            onClick={() => setStillsOpen(true)}
            className="mt-2 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            title="Grab still frames from this clip"
          >
            📷 Stills…
          </button>
          </CollapsibleSection>

          <CollapsibleSection id="freeze" title="Freeze frames">
            <FreezeFrames layer={layer} content={c} />
          </CollapsibleSection>

          <CollapsibleSection
            id="color"
            title="Color"
            right={
              !isNeutralColor(c.color) ? (
                <button
                  onClick={() => updateContent(id, { color: undefined })}
                  className="text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  Reset
                </button>
              ) : null
            }
          >
            {(() => {
              const col = c.color ?? NEUTRAL_COLOR
              const setCol =
                (prop: 'brightness' | 'contrast' | 'saturation') =>
                (p: Project, v: number): Project =>
                  mut(p, (l) =>
                    l.content.kind === 'video'
                      ? { ...l, content: { ...l.content, color: { ...(l.content.color ?? NEUTRAL_COLOR), [prop]: v } } }
                      : l
                  )
              return (
                <>
                  <Field label={`Exposure  ${col.brightness >= 0 ? '+' : ''}${col.brightness.toFixed(2)}`}>
                    <LiveRange min={-0.5} max={0.5} step={0.02} value={col.brightness} transform={setCol('brightness')} />
                  </Field>
                  <Field label={`Contrast  ${col.contrast.toFixed(2)}`}>
                    <LiveRange min={0.5} max={1.8} step={0.02} value={col.contrast} transform={setCol('contrast')} />
                  </Field>
                  <Field label={`Saturation  ${col.saturation.toFixed(2)}`}>
                    <LiveRange min={0} max={2} step={0.02} value={col.saturation} transform={setCol('saturation')} />
                  </Field>
                </>
              )
            })()}
          </CollapsibleSection>
        </>
      )}

      {/* Image-specific controls */}
      {c.kind === 'image' && (
        <CollapsibleSection id="image" title="Image">
          <Field label={`Opacity · ${Math.round(c.opacity * 100)}%`}>
            <LiveRange
              min={0}
              max={1}
              step={0.05}
              value={c.opacity}
              transform={(p, v) =>
                mut(p, (l) => (l.content.kind === 'image' ? { ...l, content: { ...l.content, opacity: v } } : l))
              }
            />
          </Field>
          <button
            onClick={() => setImageEditOpen(true)}
            className="mt-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
            title="Crop, rotate and flip this image"
          >
            ✏ Edit image…
          </button>
        </CollapsibleSection>
      )}

      {/* Text-specific controls */}
      {c.kind === 'text' && (
        <CollapsibleSection id="text" title="Text">
          <Field label="Text">
            <textarea value={c.text} rows={2} onChange={(e) => updateContent(id, { text: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex items-end gap-2">
            <Field label="Font size">
              <input
                type="number"
                step="2"
                min="12"
                value={c.fontSizePx}
                onChange={(e) => updateContent(id, { fontSizePx: Math.max(12, Number(e.target.value)) })}
                className={inputCls}
              />
            </Field>
            <Field label="Color">
              <input
                type="color"
                value={c.color}
                onChange={(e) => updateContent(id, { color: e.target.value })}
                className="h-7 w-full rounded border border-white/10 bg-black/40"
              />
            </Field>
          </div>
          <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={c.pill.enabled}
              onChange={(e) => updateContent(id, { pill: { ...c.pill, enabled: e.target.checked } })}
            />
            Background pill
          </label>
        </CollapsibleSection>
      )}

      <button
        onClick={() => remove(id)}
        className="mt-3 w-full rounded bg-rose-500/20 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/30"
      >
        Delete layer
      </button>
    </div>
  )
}

/** The shared style controls (color / font / position / rotation / pill) used by
 *  both the lane-wide caption style and a per-caption override. */
function CaptionStyleFields({
  style,
  onPatch
}: {
  style: CaptionStyle
  onPatch: (patch: Partial<CaptionStyle>) => void
}): JSX.Element {
  return (
    <>
      <div className="flex items-end gap-2">
        <Field label="Font size">
          <input
            type="number"
            step="2"
            min="12"
            value={style.fontSizePx}
            onChange={(e) => onPatch({ fontSizePx: Math.max(12, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
        <Field label="Color">
          <input
            type="color"
            value={style.color}
            onChange={(e) => onPatch({ color: e.target.value })}
            className="h-7 w-full rounded border border-white/10 bg-black/40"
          />
        </Field>
      </div>
      <Field label="Font family">
        <input
          type="text"
          value={style.fontFamily}
          onChange={(e) => onPatch({ fontFamily: e.target.value })}
          className={inputCls}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="Position X">
          <input
            type="number"
            step="5"
            value={Math.round(style.x)}
            onChange={(e) => onPatch({ x: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
        <Field label="Position Y">
          <input
            type="number"
            step="5"
            value={Math.round(style.y)}
            onChange={(e) => onPatch({ y: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
      </div>
      <Field label={`Rotation · ${Math.round(style.rotationDeg)}°`}>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={style.rotationDeg}
          onChange={(e) => onPatch({ rotationDeg: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={style.pill.enabled}
          onChange={(e) => onPatch({ pill: { ...style.pill, enabled: e.target.checked } })}
        />
        Background pill
      </label>
    </>
  )
}

/** Editing the lane-wide caption style (selected via the "Captions" gutter label):
 *  every caption without its own override updates live. */
function CaptionStyleEditor(): JSX.Element | null {
  const captions = useProject((s) => s.project?.captions)
  const setCaptionStyle = useProject((s) => s.setCaptionStyle)
  if (!captions) return null
  const overrides = captions.segments.filter((s) => s.style).length

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200">All captions</div>
      <p className="mb-3 text-[11px] text-zinc-500">
        Style every caption at once. Select a single caption block to override it individually.
      </p>
      <CaptionStyleFields style={captions.style} onPatch={(patch) => setCaptionStyle(patch)} />
      {overrides > 0 && (
        <p className="mt-1 text-[11px] text-zinc-600">
          {overrides} caption{overrides === 1 ? '' : 's'} use a custom style and ignore these settings.
        </p>
      )}
    </div>
  )
}

function CaptionEditor(): JSX.Element | null {
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const captions = useProject((s) => s.project?.captions)
  const seg = useProject((s) => s.project?.captions.segments.find((c) => c.id === selectedCaptionId) ?? null)
  const update = useProject((s) => s.updateCaption)
  const remove = useProject((s) => s.removeCaption)
  const setSegStyle = useProject((s) => s.setCaptionSegmentStyle)
  const clearSegStyle = useProject((s) => s.clearCaptionSegmentStyle)
  const selectCaption = useUi((s) => s.selectCaption)
  const selectCaptionsGlobal = useUi((s) => s.selectCaptionsGlobal)
  if (!seg || !captions) return null
  const overridden = !!seg.style
  const style = effectiveCaptionStyle(captions, seg)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-200">Caption</div>
      <Field label="Text">
        <textarea value={seg.text} rows={2} onChange={(e) => update(seg.id, { text: e.target.value })} className={inputCls} />
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
            onChange={(e) => update(seg.id, { endSec: Math.max(seg.startSec + 0.1, Number(e.target.value)) })}
            className={inputCls}
          />
        </Field>
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={seg.enabled} onChange={(e) => update(seg.id, { enabled: e.target.checked })} />
        Show this caption
      </label>

      <CollapsibleSection
        id="caption-style"
        title={overridden ? 'Style · custom' : 'Style · follows all'}
        right={
          overridden ? (
            <button onClick={() => clearSegStyle(seg.id)} className="text-[10px] text-zinc-400 hover:text-zinc-200">
              Reset to global
            </button>
          ) : null
        }
      >
        {!overridden && (
          <p className="mb-2 text-[11px] text-zinc-500">
            This caption follows the{' '}
            <button onClick={selectCaptionsGlobal} className="text-sky-400 hover:underline">
              lane-wide style
            </button>
            . Changing anything below makes it independent.
          </p>
        )}
        <CaptionStyleFields style={style} onPatch={(patch) => setSegStyle(seg.id, patch)} />
      </CollapsibleSection>

      <button
        onClick={() => {
          remove(seg.id)
          selectCaption(null)
        }}
        className="mt-3 w-full rounded bg-rose-500/20 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/30"
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
        <input type="checkbox" checked={clip.duck} onChange={(e) => update(clip.id, { duck: e.target.checked })} />
        Duck under other audio (music bed)
      </label>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={!!clip.denoise} onChange={(e) => update(clip.id, { denoise: e.target.checked })} />
        Reduce noise (on export)
      </label>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={!!clip.excludeFromCaptions}
          onChange={(e) => update(clip.id, { excludeFromCaptions: e.target.checked })}
        />
        Exclude from captions
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
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const captionsGlobalSelected = useUi((s) => s.captionsGlobalSelected)
  const layers = useProject((s) => s.project?.layers)
  const hookOk = hookCovered(layers ?? [])

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
        {selectedLayerId ? (
          <LayerEditor />
        ) : selectedCaptionId ? (
          <CaptionEditor />
        ) : captionsGlobalSelected ? (
          <CaptionStyleEditor />
        ) : selectedAudioId ? (
          <AudioClipEditor />
        ) : (
          <p className="text-sm text-zinc-600">Select a layer to edit it.</p>
        )}
      </div>
    </div>
  )
}
