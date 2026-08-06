import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  CaptionStyle,
  Composition,
  Layer,
  Project,
  Stabilize,
  TextContent,
  TimelineItemKind,
  VideoContent
} from '@shared/project'
import {
  DEFAULT_STABILIZE,
  MAX_VIDEO_SPEED,
  MIN_VIDEO_SPEED,
  NEUTRAL_COLOR,
  effectiveCaptionStyle,
  effectiveDenoise,
  effectiveOut,
  effectiveStabilize,
  isNeutralColor,
  videoSpeed
} from '@shared/project'
import { hookCovered, kfOpacity, videoSourceTime, videoTimelineTime } from '@shared/layers'
import { hasSpeedRamp, sortedRamp } from '@shared/speed'
import {
  DEFAULT_IN_SEC,
  DEFAULT_OUT_SEC,
  type TextAnimIn,
  type TextAnimOut,
  type TextAnimation
} from '@shared/textAnim'
import { useLibrary } from '@/hooks/useMedia'
import { detectSilence, onJobProgress, removeBackground, segmentAvailable } from '@/ipc/client'
import { expandGroup } from '@/lib/links'
import { speechSegments } from '@/lib/silence'
import { activeComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { formatDuration, formatFps } from '@/lib/format'
import { CollapsibleSection } from './CollapsibleSection'
import { TextStyleControls } from './TextStyleControls'
import { LayoutCells } from './LayoutCells'
import { Field, Row, dangerBtnCls, disabledCls, inputCls } from './ui'

type TriMode = 'default' | 'on' | 'off'

/**
 * Link-group awareness for the editor panels. A tile in a link group moves,
 * splits and deletes with its partners (`lib/links.ts`), so the controls that
 * would silently DESYNC the group — anything that re-times just this tile
 * (start/end, source trim, speed, freezes, detaching audio) — are disabled while
 * it's linked; per-tile looks (crop, colour, gain, style) stay live. Returns the
 * group's size, 1 when the tile is unlinked (the primitive keeps the zustand
 * selector cheap to compare).
 */
function useLinkGroupSize(kind: TimelineItemKind, id: string | null): number {
  return useProject((s) => { const c = activeComp(s); return c && id ? expandGroup(c, { kind, id }).length : 1 })
}

/** The banner explaining why this panel's timing controls are greyed out. */
function LinkedNote({ size }: { size: number }): JSX.Element {
  return (
    <p className="mb-2 rounded bg-sky-500/10 px-2 py-1 text-[10px] leading-snug text-sky-300/90">
      🔗 Linked to {size - 1} other {size === 2 ? 'tile' : 'tiles'} — they move, trim, split and
      delete together. Drag an edge on the timeline to trim the whole group; re-timing just this
      tile needs <span className="text-sky-200">⛓ Unlink</span>.
    </p>
  )
}

/** Delete this tile — or, when it's linked, its whole group (a group is only
 *  ever removed as a whole). Shared by the three editor panels. */
function useDeleteTile(kind: TimelineItemKind, id: string | null): () => void {
  const removeItems = useProject((s) => s.removeItems)
  return () => {
    const p = useProject.getState().project
    if (!p || !id) return
    removeItems(expandGroup(p, { kind, id }))
  }
}

/** The shared Default / On / Off segmented control for a tri-state per-clip
 *  override (noise reduction, stabilization). `mode` is the active segment;
 *  `defaultOn` is what the project default currently resolves to. */
function OverrideToggle({
  label,
  noun,
  effectiveOn,
  defaultOn,
  mode,
  onPick
}: {
  label: string
  noun: string
  effectiveOn: boolean
  defaultOn: boolean
  mode: TriMode
  onPick: (mode: TriMode) => void
}): JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500">→ {effectiveOn ? 'On' : 'Off'}</span>
      </div>
      <div className="flex gap-1">
        {(['default', 'on', 'off'] as const).map((key) => (
          <button
            key={key}
            onClick={() => onPick(key)}
            title={
              key === 'default'
                ? `Follow the project default (${defaultOn ? 'On' : 'Off'})`
                : `Force ${noun} ${key} for this clip`
            }
            className={`flex-1 rounded px-2 py-1 text-[11px] ${
              mode === key ? 'bg-sky-500/30 text-sky-100' : 'bg-white/5 text-zinc-400 hover:bg-white/10'
            }`}
          >
            {key === 'default' ? `Default (${defaultOn ? 'On' : 'Off'})` : key === 'on' ? 'On' : 'Off'}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Shakiness + smoothing sliders for a `Stabilize` value — shared by the per-clip
 *  override, the project default, and the Project settings menu. */
export function StabilizeSliders({
  value,
  onChange
}: {
  value: Stabilize
  onChange: (next: Stabilize) => void
}): JSX.Element {
  return (
    <>
      <Field label={`Shakiness · ${value.shakiness}`}>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={value.shakiness}
          onChange={(e) => onChange({ ...value, shakiness: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
      <Field label={`Smoothing · ${value.smoothing} frames`}>
        <input
          type="range"
          min={1}
          max={40}
          step={1}
          value={value.smoothing}
          onChange={(e) => onChange({ ...value, smoothing: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </Field>
    </>
  )
}

/**
 * "Remove background" for a video layer: runs the segmentation model over the
 * source clip (a background job) and adds the resulting transparent clip to the
 * project library, ready to drop on a lane above a new background. Export-time /
 * job effect — like stabilize, the preview only updates once the new clip exists.
 * Renders nothing when the model isn't installed, or for an already-alpha clip.
 */
function RemoveBackground({ mediaId }: { mediaId: string }): JSX.Element | null {
  const addMedia = useProject((s) => s.addMedia)
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void segmentAvailable().then(setAvailable)
  }, [])

  useEffect(() => {
    if (!busy) return undefined
    return onJobProgress((ev) => {
      if (ev.type === 'matte' && ev.subjectId === mediaId && ev.status === 'running') {
        setPct(Math.round(ev.progress * 100))
      }
    })
  }, [busy, mediaId])

  if (!available) return null

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setErr(null)
    setPct(0)
    try {
      const asset = await removeBackground(mediaId)
      addMedia([asset.id]) // surface the new "(no bg)" clip in the library
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CollapsibleSection id="removebg" title="Background">
      <button
        onClick={() => void run()}
        disabled={busy}
        title="Detect the subject and save a background-free copy of this clip to the library"
        className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50"
      >
        {busy ? `Removing background… ${pct}%` : '✂ Remove background'}
      </button>
      {err && <p className="mt-1 text-[10px] leading-snug text-rose-300">{err}</p>}
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Runs a segmentation model over the clip (a background job) and adds a transparent copy to your
        library. Drop it on a lane above a new background (color, image, or another clip).
      </p>
    </CollapsibleSection>
  )
}

/** A range slider that previews live during the drag and records one undo step
 *  on release. `transform` maps (active composition, value) → next comp — the
 *  same indirection every editing action uses, so sliders work inside nested
 *  comps too. */
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
  transform: (c: Composition, v: number) => Composition
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
        const store = useProject.getState()
        if (before.current) {
          store.liveUpdate((p) => transform(p, v))
          return
        }
        // Keyboard adjustment (no pointer drag in progress): there is no
        // pointerup to close the interaction, so record a normal undo step —
        // otherwise arrow-key changes bypass history, autosave and dirty.
        const prev = store.project
        if (!prev) return
        store.liveUpdate((p) => transform(p, v))
        store.commitLive(prev)
      }}
      onPointerUp={() => {
        if (before.current) useProject.getState().commitLive(before.current)
        before.current = null // so later keyboard changes take the commit path
      }}
      className="w-full accent-sky-400"
    />
  )
}

const setLayer = (id: string) => (c: Composition, fn: (l: Layer) => Layer): Composition => ({
  ...c,
  layers: c.layers.map((l) => (l.id === id ? fn(l) : l))
})

/** Freeze-frame controls: hold the current frame for a chosen duration, and list
 *  existing holds. Adding a freeze extends only this clip (no ripple) — which is
 *  why `disabled` (a linked tile) locks both adding and removing. */
function FreezeFrames({
  layer,
  content,
  disabled
}: {
  layer: Layer
  content: VideoContent
  disabled?: boolean
}): JSX.Element {
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
          disabled={disabled}
          className={`mb-2 flex-1 rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 ${disabledCls}`}
          title={
            disabled
              ? 'Not available on a linked tile — a freeze would stretch only this one (unlink first)'
              : 'Hold the frame at the playhead for the chosen duration'
          }
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
                disabled={disabled}
                className={`rounded px-1 text-rose-300 hover:bg-rose-500/20 ${disabledCls}`}
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
  const layer = useProject((s) => activeComp(s)?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const update = useProject((s) => s.updateLayer)
  const updateContent = useProject((s) => s.updateLayerContent)
  const groupSize = useLinkGroupSize('layer', selectedLayerId)
  const linked = groupSize > 1
  const remove = useDeleteTile('layer', selectedLayerId)
  const extractAudio = useProject((s) => s.extractLayerAudio)
  const setCropEditing = useUi((s) => s.setCropEditing)
  const setStillsOpen = useUi((s) => s.setStillsOpen)
  const setImageEditOpen = useUi((s) => s.setImageEditOpen)
  const stabilizeDefault = useProject((s) => s.project?.stabilizeDefault ?? null)
  const { data: assets = [] } = useLibrary()
  if (!layer) return null
  const id = layer.id
  const mut = setLayer(id)
  const c = layer.content
  const asset =
    c.kind === 'video' || c.kind === 'image' ? assets.find((a) => a.id === c.mediaId) : undefined
  const kindName =
    c.kind === 'video'
      ? 'Video layer'
      : c.kind === 'image'
        ? 'Image layer'
        : c.kind === 'layout'
          ? 'Layout layer'
          : 'Text layer'
  // Keyframes override the base transform for media layers; grey those fields.
  const keyframed = c.kind !== 'text' && c.kind !== 'layout' && (layer.keyframes?.length ?? 0) > 0

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200">{kindName}</div>
      {asset && (
        <div className="mb-2 truncate text-xs text-zinc-400" title={asset.fileName}>
          {asset.fileName}
        </div>
      )}

      {linked && <LinkedNote size={groupSize} />}

      <CollapsibleSection id="transform" title="Transform">
      {/* Start/End each move ONE edge (a trim, not a move), so they'd change this
          tile's length out from under the rest of its group. */}
      <div className="flex gap-2">
        <Field label="Start (s)">
          <input
            type="number"
            step="0.1"
            min="0"
            value={layer.startSec.toFixed(1)}
            disabled={linked}
            onChange={(e) => update(id, { startSec: Math.max(0, Number(e.target.value)) })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
        <Field label="End (s)">
          <input
            type="number"
            step="0.1"
            value={layer.endSec.toFixed(1)}
            disabled={linked}
            onChange={(e) => update(id, { endSec: Math.max(layer.startSec + 0.2, Number(e.target.value)) })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
      </div>

      {keyframed && (
        <p className="mb-1 text-[10px] leading-snug text-amber-300/80">
          Position &amp; zoom are animated by keyframes (below) — these base values are ignored.
        </p>
      )}
      <div className="flex gap-2">
        <Field label="Position X">
          <input
            type="number"
            step="5"
            value={Math.round(layer.x)}
            disabled={keyframed}
            onChange={(e) => update(id, { x: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
        <Field label="Position Y">
          <input
            type="number"
            step="5"
            value={Math.round(layer.y)}
            disabled={keyframed}
            onChange={(e) => update(id, { y: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
      </div>

      <Field label={`Zoom · ${Math.round(layer.scale * 100)}%`}>
        <div className={keyframed ? 'pointer-events-none opacity-40' : ''}>
          <LiveRange
            min={0.05}
            max={4}
            step={0.01}
            value={layer.scale}
            transform={(p, v) => mut(p, (l) => ({ ...l, scale: v }))}
          />
        </div>
      </Field>

      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={!layer.hidden} onChange={() => update(id, { hidden: !layer.hidden })} />
        Visible
      </label>

      {/* Any ordinary tile can become a compound clip: it moves into a nested
          timeline you then edit on its own. Linked tiles are excluded — their
          partners would be left behind in the parent. */}
      {c.kind !== 'compound' && (
        <button
          onClick={() => {
            useProject.getState().convertLayerToComp(id)
            useProject.getState().enterComposition({ layerId: id })
          }}
          disabled={linked}
          className={`mb-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 ${disabledCls}`}
          title={
            linked
              ? 'Not available on a linked tile — its partners would stay behind (unlink first)'
              : 'Move this into its own nested timeline and open it'
          }
        >
          🧩 Edit as compound clip
        </button>
      )}
      </CollapsibleSection>

      {/* Keyframed motion (video/image; text animates via its own presets;
          layouts and compounds have no export keyframe path) */}
      {c.kind !== 'text' && c.kind !== 'layout' && c.kind !== 'compound' && (
        <CollapsibleSection id="keyframes" title="Keyframes">
          <KeyframesSection layer={layer} />
        </CollapsibleSection>
      )}

      {/* Layout cells: assign a clip per panel (drag a library clip onto a cell,
          or pick it). The arrangement/aspect are chosen in the header FORMAT menu. */}
      {c.kind === 'layout' && (
        <CollapsibleSection id="layout" title="Layout">
          <LayoutCells layerId={id} content={c} />
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
            The aspect ratio is set in the <span className="text-zinc-400">Format</span> menu. Cells
            fill their panel (center-cropped) and play at 1× from the layout&apos;s start.
          </p>
        </CollapsibleSection>
      )}

      {/* Compound clip: a whole nested timeline standing in for one clip. */}
      {c.kind === 'compound' && (
        <CollapsibleSection id="compound" title="Compound clip">
          <CompoundControls layerId={id} />
        </CollapsibleSection>
      )}

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
                disabled={linked}
                onChange={(e) =>
                  updateContent(id, { inSec: Math.max(0, Math.min(Number(e.target.value), c.outSec - 0.05)) })
                }
                className={`${inputCls} ${disabledCls}`}
              />
            </Field>
            <Field label="Trim out (s)">
              <input
                type="number"
                step="0.1"
                value={c.outSec.toFixed(1)}
                disabled={linked}
                onChange={(e) => updateContent(id, { outSec: Math.max(c.inSec + 0.05, Number(e.target.value)) })}
                className={`${inputCls} ${disabledCls}`}
              />
            </Field>
          </div>
          {asset?.probe.video && (
            <Row label="Source">{`${asset.probe.video.displayWidth}×${asset.probe.video.displayHeight} · ${formatFps(asset.probe.video.avgFps)}`}</Row>
          )}
          {asset && <Row label="Duration">{formatDuration(asset.probe.durationSec)}</Row>}
          <SpeedControl layer={layer} content={c} disabled={linked} />
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
                disabled={videoSpeed(c) !== 1 || hasSpeedRamp(c) || linked}
                className={`rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 ${disabledCls}`}
                title={
                  videoSpeed(c) !== 1 || hasSpeedRamp(c)
                    ? 'Not available on a re-timed clip — the audio track plays at 1× (reset speed first)'
                    : linked
                      ? 'Not available on a linked tile — the new audio clip would not be part of the group (unlink first)'
                      : "Move this layer's audio onto the audio track and mute the layer"
                }
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
            <FreezeFrames layer={layer} content={c} disabled={linked} />
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
                (p: Composition, v: number): Composition =>
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

          <CollapsibleSection
            id="stabilize"
            title="Stabilization"
            right={
              c.stabilize !== undefined ? (
                <button
                  onClick={() => updateContent(id, { stabilize: undefined })}
                  className="text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  Reset
                </button>
              ) : null
            }
          >
            {(() => {
              const eff = effectiveStabilize(c, stabilizeDefault)
              const mode: TriMode = c.stabilize === undefined ? 'default' : c.stabilize ? 'on' : 'off'
              return (
                <>
                  <OverrideToggle
                    label="Stabilize motion (on export)"
                    noun="stabilization"
                    effectiveOn={!!eff}
                    defaultOn={!!stabilizeDefault}
                    mode={mode}
                    onPick={(key) =>
                      updateContent(id, {
                        stabilize:
                          key === 'default' ? undefined : key === 'off' ? null : { ...(eff ?? DEFAULT_STABILIZE) }
                      })
                    }
                  />
                  {c.stabilize && (
                    <StabilizeSliders
                      value={c.stabilize}
                      onChange={(next) => updateContent(id, { stabilize: next })}
                    />
                  )}
                  <p className="text-[10px] leading-snug text-zinc-500">
                    Analysed and rendered on export (a two-pass stabilize); higher smoothing is steadier but crops in more.
                    Preview is unaffected.
                  </p>
                </>
              )
            })()}
          </CollapsibleSection>

          {/* Background removal → a new transparent library clip. Hidden for a
              clip that already has alpha (a previously removed-background copy). */}
          {!asset?.probe.video?.hasAlpha && <RemoveBackground mediaId={c.mediaId} />}
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
          <TextStyleControls style={c} onPatch={(patch) => updateContent(id, patch)} />
          <TextAnimationFields content={c} onPatch={(patch) => updateContent(id, patch)} />
        </CollapsibleSection>
      )}

      <button onClick={remove} className={`mt-3 w-full ${dangerBtnCls}`}>
        {linked ? `Delete linked group (${groupSize})` : 'Delete layer'}
      </button>
    </div>
  )
}

/**
 * Position/scale keyframes for a media layer. "＋ Keyframe" captures the
 * layer's effective transform at the playhead; with keyframes present, canvas
 * drags/corner-resizes write keyframes at the playhead too (PreviewStage).
 * Motion previews and exports through the same shared interpolation
 * (`layerTransformAt`).
 */
function KeyframesSection({ layer }: { layer: Layer }): JSX.Element {
  const addKf = useProject((s) => s.addLayerKeyframe)
  const removeKf = useProject((s) => s.removeLayerKeyframe)
  const clearKfs = useProject((s) => s.clearLayerKeyframes)
  const setKfOpacity = useProject((s) => s.setLayerKeyframeOpacity)
  const setTime = usePlayback((s) => s.setTime)
  const kfs = [...(layer.keyframes ?? [])].sort((a, b) => a.tSec - b.tSec)
  return (
    <div>
      <button
        onClick={() => addKf(layer.id, usePlayback.getState().time)}
        className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        title="Capture the layer's position & zoom at the playhead as a keyframe"
      >
        ＋ Keyframe at playhead
      </button>
      {kfs.length > 0 && (
        <>
          <ul className="mt-1.5 space-y-1">
            {kfs.map((k, i) => (
              <li key={`${k.tSec}-${i}`} className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300">
                <button
                  onClick={() => setTime(layer.startSec + k.tSec)}
                  className="rounded bg-white/10 px-1 text-zinc-200 hover:bg-white/20"
                  title="Jump the playhead to this keyframe"
                >
                  ▸
                </button>
                <span className="w-10 font-mono">{k.tSec.toFixed(2)}s</span>
                <span className="flex-1 truncate text-zinc-500">
                  x{Math.round(k.x)} y{Math.round(k.y)} · {Math.round(k.scale * 100)}%
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(kfOpacity(k) * 100)}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v)) setKfOpacity(layer.id, i, v / 100)
                  }}
                  className={`${inputCls} w-12 flex-none`}
                  title="Layer opacity at this keyframe (%) — fades linearly between keyframes"
                />
                <button
                  onClick={() => removeKf(layer.id, i)}
                  className="text-zinc-500 hover:text-rose-400"
                  title="Remove this keyframe"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => clearKfs(layer.id)} className="mt-1.5 w-full rounded bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/10">
            Clear all keyframes
          </button>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Motion (and the % opacity) is linear between keyframes and holds outside them.
            Dragging the layer on the canvas updates the keyframe at the playhead.
          </p>
        </>
      )}
    </div>
  )
}


/** A compound clip's only control: open its nested timeline. Everything else
 *  about it (what's inside) is edited by entering it — that's the whole point
 *  of the compound. Its window/transform stay in the Placement section above. */
function CompoundControls({ layerId }: { layerId: string }): JSX.Element {
  const enterComposition = useProject((s) => s.enterComposition)
  return (
    <>
      <button
        onClick={() => enterComposition({ layerId })}
        className="w-full rounded bg-fuchsia-500/20 px-2 py-1.5 text-xs font-semibold text-fuchsia-200 hover:bg-fuchsia-500/40"
        title="Open this compound clip as its own timeline"
      >
        ✎ Edit contents
      </button>
      <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
        A compound clip is a whole timeline standing in for one clip — cut it, mix its audio,
        colour-grade it, layer text over it. Its result plays here from this block&apos;s start.
      </p>
    </>
  )
}

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4]

/** Clip speed: constant presets + a free field, plus a keyframed speed RAMP.
 *  Everything commits through store actions so `endSec` keeps the shared
 *  duration invariant (`playedBetween(in, out) + freeze holds`) and each
 *  change is one undo step. With a ramp active the constant controls disable
 *  (the ramp overrides them) and the clip's own audio is muted — no
 *  variable-tempo audio path, preview and export agree. `disabled` locks the
 *  whole section for a LINKED tile: re-timing one member would desync the group. */
function SpeedControl({
  layer,
  content,
  disabled
}: {
  layer: Layer
  content: VideoContent
  disabled?: boolean
}): JSX.Element {
  const layerId = layer.id
  const setSpeed = useProject((s) => s.setVideoSpeed)
  const addRampKf = useProject((s) => s.addSpeedKeyframe)
  const updateRampKf = useProject((s) => s.updateSpeedKeyframe)
  const removeRampKf = useProject((s) => s.removeSpeedKeyframe)
  const clearRamp = useProject((s) => s.clearSpeedRamp)
  const setTime = usePlayback((s) => s.setTime)
  const cur = videoSpeed(content)
  const ramped = hasSpeedRamp(content)
  const ramp = sortedRamp(content)
  return (
    // Outer wrapper keeps pointer events so the "why" tooltip still shows.
    <div
      title={
        disabled ? 'Not available on a linked tile — re-timing one member would desync the group' : undefined
      }
    >
    <div className={disabled ? 'pointer-events-none opacity-40' : ''}>
      <Field label={`Speed · ${ramped ? 'ramp' : `${cur}×`}`}>
        <div className={`flex flex-wrap gap-1 ${ramped ? 'pointer-events-none opacity-40' : ''}`}>
          {SPEED_PRESETS.map((v) => (
            <button
              key={v}
              onClick={() => setSpeed(layerId, v)}
              disabled={ramped}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                !ramped && cur === v ? 'bg-sky-500/40 text-sky-100' : 'bg-white/10 text-zinc-300 hover:bg-white/20'
              }`}
              title={v < 1 ? `Slow motion (${v}×)` : v > 1 ? `Speed up (${v}×)` : 'Normal speed'}
            >
              {v}×
            </button>
          ))}
          <input
            type="number"
            min={MIN_VIDEO_SPEED}
            max={MAX_VIDEO_SPEED}
            step={0.05}
            value={cur}
            disabled={ramped}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0) {
                setSpeed(layerId, Math.min(MAX_VIDEO_SPEED, Math.max(MIN_VIDEO_SPEED, v)))
              }
            }}
            className={`${inputCls} w-16 flex-none`}
          />
        </div>
      </Field>
      <div className="mt-1">
        <button
          onClick={() => addRampKf(layerId, usePlayback.getState().time)}
          className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
          title="Keyframe the playback speed at the playhead — speed ramps linearly between keyframes"
        >
          ＋ Speed keyframe at playhead
        </button>
        {ramped && (
          <>
            <ul className="mt-1.5 space-y-1">
              {ramp.map((k, i) => (
                <li
                  key={`${k.atSec}-${i}`}
                  className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-1 text-[10px] text-zinc-300"
                >
                  <button
                    onClick={() => setTime(videoTimelineTime(content, layer, k.atSec))}
                    className="rounded bg-white/10 px-1 text-zinc-200 hover:bg-white/20"
                    title="Jump the playhead to this speed keyframe"
                  >
                    ▸
                  </button>
                  <span className="w-10 font-mono">{k.atSec.toFixed(2)}s</span>
                  <input
                    type="number"
                    min={MIN_VIDEO_SPEED}
                    max={MAX_VIDEO_SPEED}
                    step={0.05}
                    value={k.speed}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v > 0) {
                        updateRampKf(layerId, i, Math.min(MAX_VIDEO_SPEED, Math.max(MIN_VIDEO_SPEED, v)))
                      }
                    }}
                    className={`${inputCls} w-14 flex-none`}
                    title="Playback speed at this source point"
                  />
                  <span className="flex-1 text-zinc-500">×</span>
                  <button
                    onClick={() => removeRampKf(layerId, i)}
                    className="text-zinc-500 hover:text-rose-400"
                    title="Remove this speed keyframe"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() => clearRamp(layerId)}
              className="mt-1.5 w-full rounded bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/10"
            >
              Clear speed ramp
            </button>
            <p className="mt-1 text-[10px] leading-snug text-zinc-500">
              Speed ramps linearly between keyframes (times are source seconds) and holds flat
              outside them. The clip&apos;s own audio is muted while a ramp is active.
            </p>
          </>
        )}
      </div>
    </div>
    </div>
  )
}

const ANIM_IN_OPTIONS: { value: TextAnimIn; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fadeIn', label: 'Fade in' },
  { value: 'slideUp', label: 'Slide in from bottom' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'wordHighlight', label: 'Word-by-word highlight' }
]
const ANIM_OUT_OPTIONS: { value: TextAnimOut; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fadeOut', label: 'Fade out' },
  { value: 'slideDown', label: 'Slide out' }
]

/** Entrance/exit animation controls for a text layer. Disabled while the layer
 *  burns as a rasterised PNG (gradient fill / fixed wrap width) — that path
 *  can't animate, and `effectiveTextAnimation` ignores the setting there so
 *  preview and export agree. */
function TextAnimationFields({
  content,
  onPatch
}: {
  content: TextContent
  onPatch: (patch: Partial<TextContent>) => void
}): JSX.Element {
  const anim: TextAnimation = content.animation ?? {
    in: 'none',
    inSec: DEFAULT_IN_SEC.fadeIn,
    out: 'none',
    outSec: DEFAULT_OUT_SEC
  }
  const disabled = !!content.gradient || content.widthPx != null
  const patch = (p: Partial<TextAnimation>): void => onPatch({ animation: { ...anim, ...p } })
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <div className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Animation</div>
      {disabled && (
        <p className="mb-1 text-[10px] leading-snug text-amber-300/80">
          Not available with a gradient fill or a fixed wrap width (that text is rendered as an image).
        </p>
      )}
      <div className="flex gap-2">
        <Field label="Entrance">
          <select
            value={anim.in}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value as TextAnimIn
              patch({ in: v, inSec: DEFAULT_IN_SEC[v] })
            }}
            className={inputCls}
          >
            {ANIM_IN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="In (s)">
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            value={anim.inSec}
            disabled={disabled || anim.in === 'none' || anim.in === 'wordHighlight'}
            title={anim.in === 'wordHighlight' ? 'Word-by-word spans the whole layer duration' : undefined}
            onChange={(e) => patch({ inSec: Math.max(0.1, Number(e.target.value) || 0.1) })}
            className={inputCls}
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Field label="Exit">
          <select
            value={anim.out}
            disabled={disabled}
            onChange={(e) => patch({ out: e.target.value as TextAnimOut, outSec: DEFAULT_OUT_SEC })}
            className={inputCls}
          >
            {ANIM_OUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Out (s)">
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            value={anim.outSec}
            disabled={disabled || anim.out === 'none'}
            onChange={(e) => patch({ outSec: Math.max(0.1, Number(e.target.value) || 0.1) })}
            className={inputCls}
          />
        </Field>
      </div>
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
      <TextStyleControls style={style} onPatch={onPatch} />
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
    </>
  )
}

/** Editing the lane-wide caption style (selected via the "Captions" gutter label):
 *  every caption without its own override updates live. */
function CaptionStyleEditor(): JSX.Element | null {
  const captions = useProject((s) => activeComp(s)?.captions)
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
  const captions = useProject((s) => activeComp(s)?.captions)
  const seg = useProject((s) => activeComp(s)?.captions.segments.find((c) => c.id === selectedCaptionId) ?? null)
  const update = useProject((s) => s.updateCaption)
  const groupSize = useLinkGroupSize('caption', selectedCaptionId)
  const linked = groupSize > 1
  const remove = useDeleteTile('caption', selectedCaptionId)
  const setSegStyle = useProject((s) => s.setCaptionSegmentStyle)
  const clearSegStyle = useProject((s) => s.clearCaptionSegmentStyle)
  const selectCaptionsGlobal = useUi((s) => s.selectCaptionsGlobal)
  if (!seg || !captions) return null
  const overridden = !!seg.style
  const style = effectiveCaptionStyle(captions, seg)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-200">Caption</div>
      {linked && <LinkedNote size={groupSize} />}
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
            disabled={linked}
            onChange={(e) => update(seg.id, { startSec: Math.max(0, Number(e.target.value)) })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
        <Field label="End (s)">
          <input
            type="number"
            step="0.1"
            value={seg.endSec.toFixed(1)}
            disabled={linked}
            onChange={(e) => update(seg.id, { endSec: Math.max(seg.startSec + 0.1, Number(e.target.value)) })}
            className={`${inputCls} ${disabledCls}`}
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

      <button onClick={remove} className={`mt-3 w-full ${dangerBtnCls}`}>
        {linked ? `Delete linked group (${groupSize})` : 'Delete caption'}
      </button>
    </div>
  )
}

function AudioClipEditor(): JSX.Element | null {
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const clip = useProject((s) => activeComp(s)?.audioClips.find((a) => a.id === selectedAudioId) ?? null)
  const update = useProject((s) => s.updateAudioClip)
  const groupSize = useLinkGroupSize('audio', selectedAudioId)
  const linked = groupSize > 1
  const remove = useDeleteTile('audio', selectedAudioId)
  const moveItems = useProject((s) => s.moveItemsBy)
  const denoiseDefault = useProject((s) => s.project?.denoiseDefault ?? false)
  const splitOnSilence = useProject((s) => s.splitAudioOnSilence)
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
      {linked && <LinkedNote size={groupSize} />}
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
      {/* An audio clip's Start is a MOVE (its trim doesn't change), so unlike a
          layer's it translates onto a group: the whole group shifts by the delta. */}
      <Field label={linked ? 'Start (s) · moves the group' : 'Start (s)'}>
        <input
          type="number"
          step="0.1"
          min="0"
          value={clip.startSec.toFixed(1)}
          onChange={(e) => {
            const next = Math.max(0, Number(e.target.value))
            if (!linked) return update(clip.id, { startSec: next })
            const p = useProject.getState().project
            if (p) moveItems(expandGroup(p, { kind: 'audio', id: clip.id }), next - clip.startSec)
          }}
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
      <OverrideToggle
        label="Reduce noise (on export)"
        noun="noise reduction"
        effectiveOn={effectiveDenoise(clip, denoiseDefault)}
        defaultOn={denoiseDefault}
        mode={clip.denoise === undefined ? 'default' : clip.denoise ? 'on' : 'off'}
        onPick={(key) =>
          update(clip.id, { denoise: key === 'default' ? undefined : key === 'on' })
        }
      />
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
        disabled={splitting || linked}
        className={`mb-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50 ${disabledCls}`}
        title={
          linked
            ? 'Not available on a linked tile — the pieces would cut only this one (unlink first)'
            : 'Detect silence and split this clip into its speech segments'
        }
      >
        {splitting ? 'Detecting…' : '✂ Split on silence'}
      </button>
      {splitNote && <p className="mb-2 text-[11px] text-zinc-500">{splitNote}</p>}

      <button onClick={remove} className={`mt-2 w-full ${dangerBtnCls}`}>
        {linked ? `Delete linked group (${groupSize})` : 'Remove audio clip'}
      </button>
    </div>
  )
}

export function Inspector(): JSX.Element {
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const captionsGlobalSelected = useUi((s) => s.captionsGlobalSelected)
  const layers = useProject((s) => activeComp(s)?.layers)
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
          <p className="text-sm text-zinc-600">Select a layer, caption, or audio clip to edit it.</p>
        )}
      </div>
    </div>
  )
}
