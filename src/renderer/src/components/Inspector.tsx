import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  AudioClip,
  CaptionSegment,
  CaptionStyle,
  Composition,
  Layer,
  Project,
  Stabilize,
  TextContent,
  TimelineItemKind,
  VideoContent,
  VolumeLevel
} from '@shared/project'
import { levelOf, levelStatusText } from '@shared/volumeLevels'
import { useClipGain } from '@/hooks/useClipGain'
import { LevelLoudnessField } from './VolumeLevelDialog'
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
import {
  hookCovered,
  kfOpacity,
  layerFitScale,
  layerTransformAt,
  videoSourceTime,
  videoSourceWindow,
  videoTimelineTime,
  type FrameRect
} from '@shared/layers'
import type { MediaAsset } from '@shared/media'
import { assetAspect } from '@shared/media'
import { isJobActive } from '@shared/jobs'
import { hasSpeedRamp, sortedRamp } from '@shared/speed'
import {
  DEFAULT_IN_SEC,
  DEFAULT_OUT_SEC,
  type TextAnimIn,
  type TextAnimOut,
  type TextAnimation
} from '@shared/textAnim'
import type { AudioFx, AudioFxKind, AudioFxSettings, ChorusEffect, EchoEffect, EnsembleEffect } from '@shared/audioFx'
import { CHORUS_RANGE, DEFAULT_CHORUS, DEFAULT_ECHO, DEFAULT_ENSEMBLE, ECHO_RANGE, ENSEMBLE_RANGE, fxLabel } from '@shared/audioFx'
import type { SparkleEffect } from '@shared/sparkle'
import { DEFAULT_SPARKLE, SPARKLE_DENSITY_RANGE } from '@shared/sparkle'
import { useAddAudioFx, useLibrary } from '@/hooks/useMedia'
import { detectSilence, segmentAvailable } from '@/ipc/client'
import { removeLayerBackground } from '@/lib/backgroundRemoval'
import { latestJob, useEditor } from '@/state/store'
import { CancelJobButton, jobProgressText, useNow } from './JobsIndicator'
import { expandGroup } from '@/lib/links'
import { compositionDuration } from '@shared/compositions'
import { maxItemEndSec } from '@shared/assistant/onScreenText'
import { speechSegments } from '@/lib/silence'
import { captionWithText } from '@/lib/captions'
import { activeComp, projectFormat, useProject } from '@/state/projectStore'
import { startPointerDrag } from '@/lib/pointerDrag'
import { idle } from '@/lib/interaction'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { formatDuration, formatFps } from '@/lib/format'
import { CollapsibleSection } from './CollapsibleSection'
import { TextStyleControls } from './TextStyleControls'
import { LayoutCells } from './LayoutCells'
import {
  AngleField,
  Check,
  Field,
  NumberInput,
  Row,
  Slider,
  btnCls,
  colorCls,
  dangerBtnCls,
  disabledCls,
  inputCls,
  subtleBtnCls,
  toggleCls
} from './ui'
import {
  DEFAULT_MOTION_SEC,
  MIN_MOTION_SEC,
  editSimpleMotion,
  isSimpleMotion,
  newMotionKeyframes,
  simpleMotion
} from '@shared/motion'

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

/** The latest a layer or caption may end via its End (s) field: the assistant's
 *  `set_text` rule (`maxItemEndSec`) over the same measure (`compositionDuration`
 *  of the comp being edited), but WITHOUT the layer being edited — End commits
 *  live while typing, so a bound that counted the layer itself would move with
 *  every keystroke. Without it a typo like `1e999` or `300000` crashed or froze
 *  the timeline. */
function useMaxEndSec(editedLayerId: string | null): number {
  const { data: assets = [] } = useLibrary()
  return useProject((s) => {
    const c = activeComp(s)
    if (!c) return Number.POSITIVE_INFINITY
    const rest = { ...c, layers: c.layers.filter((l) => l.id !== editedLayerId) }
    return maxItemEndSec(compositionDuration(rest, (mid) => assets.find((a) => a.id === mid)?.probe.durationSec ?? 0))
  })
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
 * "Remove background" for a video layer: mattes ONLY the footage this layer
 * plays (its source window) as a background job, then swaps the transparent
 * result in place — same lane, position and timing; Undo restores the original
 * (`lib/backgroundRemoval.ts`). Job state comes from the shared jobs map, so
 * the progress / ETA / Cancel row survives selecting another layer and coming
 * back, and the header's job indicator shows the same job meanwhile.
 * Renders nothing when the model isn't installed.
 */
function RemoveBackground({
  layerId,
  content,
  asset
}: {
  layerId: string
  content: VideoContent
  asset: MediaAsset | undefined
}): JSX.Element | null {
  const [available, setAvailable] = useState(false)
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const job = useEditor((s) => latestJob(s.jobs, 'matte', layerId))
  const running = !!job && isJobActive(job.status)
  const now = useNow(running)

  useEffect(() => {
    void segmentAvailable().then(setAvailable)
  }, [])

  if (!available) return null

  if (asset?.probe.video?.hasAlpha) {
    return (
      <CollapsibleSection id="removebg" title="Background">
        <p className="text-[10px] leading-snug text-zinc-500">
          Background removed — this clip is transparent, so whatever sits on the lanes below shows through (a
          color, an image, another clip).
        </p>
      </CollapsibleSection>
    )
  }

  const { startSec, durationSec } = videoSourceWindow(content)
  const run = async (): Promise<void> => {
    if (running || starting || !asset) return
    setStarting(true)
    setNote(null)
    try {
      const outcome = await removeLayerBackground(layerId, asset)
      if (outcome === 'canceled') setNote({ text: 'Canceled — the clip is unchanged.' })
      if (outcome === 'kept-in-library') {
        setNote({
          text: 'This clip changed while the background was being removed, so the transparent copy was added to your library instead.'
        })
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setStarting(false)
    }
  }
  const failed = !running && !note && job?.status === 'error' ? job.error : undefined

  return (
    <CollapsibleSection id="removebg" title="Background">
      <button
        onClick={() => void run()}
        disabled={running || starting || !asset || durationSec <= 0}
        title="Detect the subject and replace this clip with a background-free version of it"
        className="w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50"
      >
        {running ? `Removing background… ${Math.round(job.progress * 100)}%` : starting ? 'Starting…' : '✂ Remove background'}
      </button>
      {running && (
        <div className="mt-1.5 flex items-center gap-2" data-testid="matte-progress">
          <div className="h-1 flex-1 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-sky-400" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <span className="shrink-0 text-[10px] text-zinc-400">{jobProgressText(job, now)}</span>
          <CancelJobButton job={job} />
        </div>
      )}
      {note && <p className={`mt-1 text-[10px] leading-snug ${note.error ? 'text-rose-300' : 'text-zinc-400'}`}>{note.text}</p>}
      {failed && <p className="mt-1 text-[10px] leading-snug text-rose-300">{failed}</p>}
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
        Removes the background from just this clip&apos;s {formatDuration(durationSec)} of footage (source{' '}
        {formatDuration(startSec)}–{formatDuration(startSec + durationSec)}) and swaps it in place — same spot, same
        timing. Undo brings the original back. Put a new background (color, image, another clip) on a lane below.
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
      onPointerDown={() => {
        before.current = useProject.getState().project
        // startPointerDrag: a window-level release (incl. pointercancel, or the
        // Inspector unmounting mid-drag) + the interaction lock.
        startPointerDrag(
          () => {},
          () => {
            if (before.current) useProject.getState().commitLive(before.current)
            before.current = null // so later keyboard changes take the commit path
          }
        )
      }}
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
          <NumberInput step="0.5" min={0.1} value={hold} onCommit={setHold} />
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
  const format = useProject(projectFormat)
  const setVideoCrop = useProject((s) => s.setVideoCrop)
  const { data: assets = [] } = useLibrary()
  const maxEnd = useMaxEndSec(selectedLayerId)
  if (!layer) return null
  const id = layer.id
  const mut = setLayer(id)
  const c = layer.content
  const asset =
    c.kind === 'video' || c.kind === 'image' ? assets.find((a) => a.id === c.mediaId) : undefined
  // Position and zoom READ frame-relative (0,0 = the frame's top-left, 100% =
  // fits the frame); the document stays in canonical coords, so a format switch
  // never rewrites them. Identity in 9:16.
  const frame = format.frame
  const zoomBase = layerFitScale(layer, assetAspect(asset), frame)
  const kindName =
    c.kind === 'video'
      ? 'Video layer'
      : c.kind === 'image'
        ? 'Image layer'
        : c.kind === 'layout'
          ? 'Layout layer'
          : 'Text layer'
  // Keyframes override the base transform for media layers; grey those fields.
  // A text layer's keyframes are its straight-line motion: they own its
  // POSITION only (its size is never keyframed).
  const hasKfs = (layer.keyframes?.length ?? 0) > 0
  const keyframed = c.kind !== 'text' && c.kind !== 'layout' && hasKfs
  const posKeyframed = keyframed || (c.kind === 'text' && hasKfs)

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
          <NumberInput
            step="0.1"
            min={0}
            max={layer.endSec - 0.2}
            value={layer.startSec}
            format={(v) => v.toFixed(1)}
            disabled={linked}
            onCommit={(v) => update(id, { startSec: v })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
        <Field label="End (s)">
          <NumberInput
            step="0.1"
            min={layer.startSec + 0.2}
            max={Math.max(layer.startSec + 0.2, maxEnd)}
            value={layer.endSec}
            format={(v) => v.toFixed(1)}
            disabled={linked}
            onCommit={(v) => update(id, { endSec: v })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
      </div>

      {posKeyframed && (
        <p className="mb-1 text-[10px] leading-snug text-amber-300/80">
          {keyframed
            ? 'Position & zoom are animated by keyframes (below) — these base values are ignored.'
            : 'Position follows the motion (below) — drag the text to move its whole path.'}
        </p>
      )}
      <div className="flex gap-2">
        <Field label="Position X">
          <NumberInput
            step="5"
            value={Math.round(layer.x - frame.x)}
            disabled={posKeyframed}
            onCommit={(v) => update(id, { x: v + frame.x })}
          />
        </Field>
        <Field label="Position Y">
          <NumberInput
            step="5"
            value={Math.round(layer.y - frame.y)}
            disabled={posKeyframed}
            onCommit={(v) => update(id, { y: v + frame.y })}
          />
        </Field>
      </div>

      <Field label={`Zoom · ${Math.round((layer.scale / zoomBase) * 100)}%`}>
        <div className={keyframed ? 'pointer-events-none opacity-40' : ''}>
          <LiveRange
            min={0.05}
            max={4}
            step={0.01}
            value={layer.scale / zoomBase}
            transform={(p, v) => mut(p, (l) => ({ ...l, scale: v * zoomBase }))}
          />
        </div>
      </Field>

      {/* Rotation: the same control captions use, paired with the canvas
          handle. Layouts and compound clips don't rotate (yet). */}
      {(c.kind === 'video' || c.kind === 'image' || c.kind === 'text') && (
        <AngleField value={layer.rotationDeg ?? 0} onChange={(deg) => update(id, { rotationDeg: deg || undefined })} />
      )}
      {c.kind === 'video' && (
        <div className="mb-2 flex gap-1">
          <button
            type="button"
            className={toggleCls(!!c.flipH)}
            onClick={() => updateContent(id, { flipH: !c.flipH })}
            title="Mirror left–right"
          >
            ⇋ Flip H
          </button>
          <button
            type="button"
            className={toggleCls(!!c.flipV)}
            onClick={() => updateContent(id, { flipV: !c.flipV })}
            title="Mirror top–bottom"
          >
            ⇵ Flip V
          </button>
        </div>
      )}

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

      {/* Straight-line motion: start point → end point over a duration. Two
          keyframes under the hood (shared/motion.ts), so for media the
          Keyframes list below is the advanced view of the same data. */}
      {(c.kind === 'video' || c.kind === 'image' || c.kind === 'text') && (
        <CollapsibleSection id="motion" title="Motion">
          <MotionFields layer={layer} frame={frame} />
        </CollapsibleSection>
      )}

      {/* Keyframed motion (video/image; text animates via its own presets;
          layouts and compounds have no export keyframe path) */}
      {c.kind !== 'text' && c.kind !== 'layout' && c.kind !== 'compound' && (
        <CollapsibleSection id="keyframes" title="Keyframes">
          <KeyframesSection layer={layer} frame={frame} zoomBase={zoomBase} />
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
              <NumberInput
                step="0.1"
                min={0}
                max={c.outSec - 0.05}
                value={c.inSec}
                format={(v) => v.toFixed(1)}
                disabled={linked}
                onCommit={(v) => updateContent(id, { inSec: v })}
                className={`${inputCls} ${disabledCls}`}
              />
            </Field>
            <Field label="Trim out (s)">
              <NumberInput
                step="0.1"
                min={c.inSec + 0.05}
                value={c.outSec}
                format={(v) => v.toFixed(1)}
                disabled={linked}
                onCommit={(v) => updateContent(id, { outSec: v })}
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
              {c.crop ? 'Edit crop' : `Crop to ${format.ratioLabel}`}
            </button>
            {c.crop && (
              <button
                onClick={() => setVideoCrop(id, null, assetAspect(asset) ?? c.crop!.w / c.crop!.h)}
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

          <SoundEffectsSection
            key={`sfx-${layer.id}`}
            sourceMediaId={c.mediaId}
            inSec={c.inSec}
            outSec={c.outSec}
            startSec={layer.startSec}
            linkGroupId={layer.linkGroupId}
            disabledReason={asset?.probe.audio ? null : 'This clip has no audio track to build an effect from.'}
          />

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

          {/* Background removal → this clip's segment, matted and swapped in
              place. An already-transparent clip just says so. */}
          <RemoveBackground key={`matte-${id}`} layerId={id} content={c} asset={asset} />
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

      {c.kind === 'text' && (
        <CollapsibleSection id="texteffects" title="Text effects">
          <TextEffectsFields content={c} onPatch={(patch) => updateContent(id, patch)} />
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
/**
 * The simple Motion editor: "Add motion" starts a straight-line move AT THE
 * PLAYHEAD from where the layer is now; then the start/end points, start time
 * and duration are editable here (and the two points by dragging their dots on
 * the canvas). Points read frame-relative like Position X/Y. A layer whose
 * keyframes are not a simple move says so instead of guessing.
 */
function MotionFields({ layer, frame }: { layer: Layer; frame: FrameRect }): JSX.Element {
  const update = useProject((s) => s.updateLayer)
  const [durSec, setDurSec] = useState(DEFAULT_MOTION_SEC)
  const kfs = layer.keyframes
  const len = Math.max(0, layer.endSec - layer.startSec)
  const isText = layer.content.kind === 'text'

  if (!kfs || kfs.length === 0) {
    const add = (): void => {
      const t = usePlayback.getState().time
      const tr = layerTransformAt(layer, t)
      update(layer.id, { keyframes: newMotionKeyframes(tr, t - layer.startSec, durSec, len, frame) })
    }
    return (
      <>
        <p className="mb-2 text-[10px] leading-snug text-zinc-500">
          Moves in a straight line from where it is now, starting at the playhead. Then drag the dots on the
          preview to set where it starts and ends.
        </p>
        <div className="flex items-end gap-2">
          <Field label="Duration (s)">
            <NumberInput step="0.1" min={MIN_MOTION_SEC} value={durSec} format={(v) => v.toFixed(1)} onCommit={setDurSec} />
          </Field>
          <button type="button" onClick={add} className={`${btnCls} mb-2 shrink-0`}>
            ➜ Add motion
          </button>
        </div>
      </>
    )
  }

  const remove = (
    <button
      type="button"
      className={`${subtleBtnCls} w-full`}
      // Leave the layer where its move starts, rather than jumping back to a
      // base position nobody has seen since the move was added.
      onClick={() => {
        const first = [...kfs].sort((a, b) => a.tSec - b.tSec)[0]
        update(layer.id, { keyframes: undefined, x: first.x, y: first.y })
      }}
    >
      Remove motion
    </button>
  )

  if (!isSimpleMotion(kfs)) {
    return (
      <>
        <p className="mb-2 text-[10px] leading-snug text-zinc-500">
          {kfs.length} keyframes — more than a simple start → end move.
          {isText ? ' The text follows the first stretch that moves.' : ' Edit them under Keyframes.'}
        </p>
        {isText && remove}
      </>
    )
  }

  const mo = simpleMotion(kfs)
  const edit = (patch: Parameters<typeof editSimpleMotion>[1]): void =>
    update(layer.id, { keyframes: editSimpleMotion(kfs, patch, len) })
  const coord = (label: string, v: number, origin: number, key: 'x0' | 'y0' | 'x1' | 'y1'): JSX.Element => (
    <Field label={label}>
      <NumberInput step="5" value={Math.round(v - origin)} onCommit={(n) => edit({ [key]: n + origin })} />
    </Field>
  )
  return (
    <>
      <div className="flex gap-2">
        {coord('Start X', mo.x0, frame.x, 'x0')}
        {coord('Start Y', mo.y0, frame.y, 'y0')}
      </div>
      <div className="flex gap-2">
        {coord('End X', mo.x1, frame.x, 'x1')}
        {coord('End Y', mo.y1, frame.y, 'y1')}
      </div>
      <div className="flex gap-2">
        <Field label="Starts at (s)">
          <NumberInput step="0.1" min={0} value={mo.t0} format={(v) => v.toFixed(1)} onCommit={(t0) => edit({ t0 })} />
        </Field>
        <Field label="Duration (s)">
          <NumberInput
            step="0.1"
            min={MIN_MOTION_SEC}
            value={mo.t1 - mo.t0}
            format={(v) => v.toFixed(1)}
            onCommit={(d) => edit({ durSec: d })}
          />
        </Field>
      </div>
      {remove}
    </>
  )
}

function KeyframesSection({
  layer,
  frame,
  zoomBase
}: {
  layer: Layer
  /** Keyframe values display frame-relative, like the Transform fields. */
  frame: FrameRect
  zoomBase: number
}): JSX.Element {
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
                  x{Math.round(k.x - frame.x)} y{Math.round(k.y - frame.y)} · {Math.round((k.scale / zoomBase) * 100)}%
                </span>
                <NumberInput
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(kfOpacity(k) * 100)}
                  onCommit={(v) => setKfOpacity(layer.id, i, v / 100)}
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
          <NumberInput
            min={MIN_VIDEO_SPEED}
            max={MAX_VIDEO_SPEED}
            step={0.05}
            value={cur}
            disabled={ramped}
            onCommit={(v) => setSpeed(layerId, v)}
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
                  <NumberInput
                    min={MIN_VIDEO_SPEED}
                    max={MAX_VIDEO_SPEED}
                    step={0.05}
                    value={k.speed}
                    onCommit={(v) => updateRampKf(layerId, i, v)}
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
          <NumberInput
            min={0.1}
            max={10}
            step={0.1}
            value={anim.inSec}
            disabled={disabled || anim.in === 'none' || anim.in === 'wordHighlight'}
            title={anim.in === 'wordHighlight' ? 'Word-by-word spans the whole layer duration' : undefined}
            onCommit={(v) => patch({ inSec: v })}
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
          <NumberInput
            min={0.1}
            max={10}
            step={0.1}
            value={anim.outSec}
            disabled={disabled || anim.out === 'none'}
            onCommit={(v) => patch({ outSec: v })}
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
          <NumberInput step="5" value={Math.round(style.x)} onCommit={(x) => onPatch({ x })} />
        </Field>
        <Field label="Position Y">
          <NumberInput step="5" value={Math.round(style.y)} onCommit={(y) => onPatch({ y })} />
        </Field>
      </div>
      <AngleField value={style.rotationDeg} onChange={(rotationDeg) => onPatch({ rotationDeg })} />
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

/**
 * A caption's text box. Every change re-times the words through
 * `captionWithText` — split rebuilds text from the words, so text alone would
 * revert at the next split. It re-times from the words the caption had when the
 * box got focus, so intermediate keystrokes (a half-typed word, a stray space)
 * never wear the original timings down.
 */
function CaptionTextInput({
  seg,
  onChange
}: {
  seg: CaptionSegment
  onChange: (next: CaptionSegment) => void
}): JSX.Element {
  const origin = useRef<CaptionSegment | null>(null)
  // The focus-time words, unless the caption has since moved (then they'd be in the wrong place).
  const base = (): CaptionSegment => {
    const o = origin.current
    return o && o.id === seg.id && o.startSec === seg.startSec && o.endSec === seg.endSec ? o : seg
  }
  return (
    <textarea
      value={seg.text}
      rows={2}
      onFocus={() => (origin.current = seg)}
      onBlur={() => (origin.current = null)}
      onChange={(e) => onChange(captionWithText(base(), e.target.value))}
      className={inputCls}
    />
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
  const maxEnd = useMaxEndSec(null) // captions don't count toward the edit's length
  if (!seg || !captions) return null
  const overridden = !!seg.style
  const style = effectiveCaptionStyle(captions, seg)

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-200">Caption</div>
      {linked && <LinkedNote size={groupSize} />}
      <Field label="Text">
        <CaptionTextInput seg={seg} onChange={(next) => update(seg.id, { text: next.text, words: next.words })} />
      </Field>
      <div className="flex gap-2">
        <Field label="Start (s)">
          <NumberInput
            step="0.1"
            min={0}
            max={seg.endSec - 0.1}
            value={seg.startSec}
            format={(v) => v.toFixed(1)}
            disabled={linked}
            onCommit={(v) => update(seg.id, { startSec: v })}
            className={`${inputCls} ${disabledCls}`}
          />
        </Field>
        <Field label="End (s)">
          <NumberInput
            step="0.1"
            min={seg.startSec + 0.1}
            max={Math.max(seg.startSec + 0.1, maxEnd)}
            value={seg.endSec}
            format={(v) => v.toFixed(1)}
            disabled={linked}
            onCommit={(v) => update(seg.id, { endSec: v })}
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
      await idle() // detection can finish mid-drag; the split waits for the release
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
      <Check checked={!!clip.mute} onChange={(v) => update(clip.id, { mute: v })}>
        🔇 Mute this clip
      </Check>
      <ClipVolumeSection clip={clip} />
      {/* An audio clip's Start is a MOVE (its trim doesn't change), so unlike a
          layer's it translates onto a group: the whole group shifts by the delta. */}
      <Field label={linked ? 'Start (s) · moves the group' : 'Start (s)'}>
        <NumberInput
          step="0.1"
          min={0}
          value={clip.startSec}
          format={(v) => v.toFixed(1)}
          onCommit={(next) => {
            if (!linked) return update(clip.id, { startSec: next })
            const p = useProject.getState().project
            if (p) moveItems(expandGroup(p, { kind: 'audio', id: clip.id }), next - clip.startSec)
          }}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="Fade in (s)">
          <NumberInput
            step="0.5"
            min={0}
            value={clip.fadeInSec}
            onCommit={(v) => update(clip.id, { fadeInSec: v })}
          />
        </Field>
        <Field label="Fade out (s)">
          <NumberInput
            step="0.5"
            min={0}
            value={clip.fadeOutSec}
            onCommit={(v) => update(clip.id, { fadeOutSec: v })}
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

      {/* An effect track re-renders from the clip it was BUILT from, not from
          its own (already wet) audio — an echo of an echo is not the intent. */}
      <SoundEffectsSection
        key={clip.id}
        sourceMediaId={clip.fx ? clip.fx.fromMediaId : clip.mediaId}
        inSec={clip.fx ? clip.fx.fromInSec : clip.inSec}
        outSec={clip.fx ? clip.fx.fromOutSec : effectiveOut(clip, asset?.probe.durationSec ?? clip.outSec)}
        startSec={clip.startSec}
        linkGroupId={clip.linkGroupId}
        existing={clip.fx}
        replaceClipId={clip.fx ? clip.id : undefined}
      />

      <button onClick={remove} className={`mt-2 w-full ${dangerBtnCls}`}>
        {linked ? `Delete linked group (${groupSize})` : 'Remove audio clip'}
      </button>
    </div>
  )
}

const NO_LEVELS: VolumeLevel[] = []
const NO_CLIPS: AudioClip[] = []
const NEW_LEVEL = '__new-level'

/**
 * An audio clip's loudness controls, top to bottom: its OWN volume slider; the
 * "Volume level" picker; and, for a clip in a level, that level's loudness
 * (which moves every clip in it) with the status line saying what the level
 * did to this clip. The gain itself comes from `clipGain` — the export's call.
 *
 * The own slider keeps its value, but is greyed out and locked while the clip
 * is muted (unmuting restores it) or in a level (leaving restores it).
 */
function ClipVolumeSection({ clip }: { clip: AudioClip }): JSX.Element {
  const update = useProject((s) => s.updateAudioClip)
  const setClipsLevel = useProject((s) => s.setClipsVolumeLevel)
  const levels = useProject((s) => s.project?.volumeLevels ?? NO_LEVELS)
  const clips = useProject((s) => activeComp(s)?.audioClips ?? NO_CLIPS)
  const { data: assets = [] } = useLibrary()
  const durationOf = (id: string): number => assets.find((a) => a.id === id)?.probe.durationSec ?? 0
  const gain = useClipGain(clip, clips, durationOf)
  const isFx = clip.kind === 'fx'
  const level = levelOf(clip, levels)
  const followed = gain.status.kind === 'follows' ? levels.find((l) => l.id === gain.levelId) : null
  const status = levelStatusText(gain.status, gain.gainDb)

  const label = clip.mute
    ? `Volume · muted (${clip.gainDb} dB)`
    : level
      ? `Volume · ${clip.gainDb} dB · set by the level`
      : `Volume · ${clip.gainDb} dB`
  return (
    <>
      <Field label={label}>
        <Slider
          ariaLabel="Clip volume"
          min={-40}
          max={24}
          step={1}
          value={clip.gainDb}
          disabled={!!clip.mute || !!level}
          title={level ? `Set by the “${level.name}” volume level — choose None below to use this again` : undefined}
          onChange={(v) => update(clip.id, { gainDb: v })}
          className={`w-full ${disabledCls}`}
        />
      </Field>
      <Field label="Volume level">
        <select
          data-testid="volume-level-select"
          value={isFx ? '' : (level?.id ?? '')}
          disabled={isFx}
          title={isFx ? 'An effect track follows the level of the clip it was made from' : undefined}
          onChange={(e) => {
            const v = e.target.value
            if (v === NEW_LEVEL) useUi.getState().setLevelDialog({ mode: 'create', assign: [clip.id] })
            else setClipsLevel([clip.id], v || null)
          }}
          className={`${inputCls} ${disabledCls}`}
        >
          <option value="">None — its own volume</option>
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.targetLufs} LUFS)
            </option>
          ))}
          <option value={NEW_LEVEL}>New level…</option>
        </select>
      </Field>
      {level && <LevelLoudnessField levelId={level.id} />}
      {followed && (
        <p className="-mt-1 mb-2 text-[11px] text-zinc-500">
          Its source clip is in “{followed.name}” ({followed.targetLufs} LUFS).
        </p>
      )}
      {status && (
        <p
          data-testid="level-status"
          className={`-mt-1 mb-2 text-[11px] ${gain.status.kind === 'short' ? 'text-amber-300' : 'text-zinc-400'}`}
        >
          {status}
        </p>
      )}
    </>
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

const FX_KINDS: { value: AudioFxKind; label: string; hint: string }[] = [
  { value: 'echo', label: 'Echo', hint: 'Repeats that fall away — lands emphasis on a word.' },
  {
    value: 'ensemble',
    label: 'Ensemble',
    hint: 'Copies at a fixed detune, stacked — thickens a voice without movement.'
  },
  {
    value: 'chorus',
    label: 'Chorus',
    hint: 'Copies whose pitch drifts back and forth — the classic shimmer.'
  }
]

/**
 * "Sound effects" — builds an echo or chorus from the selected clip's audio and
 * drops it on the timeline as its OWN track, mixed over the untouched original.
 *
 * The wet signal is rendered to a real audio asset rather than resolved at
 * export time, so what plays in the preview is what the export mixes, the
 * timeline draws the effect's own waveform, and the track can be moved, faded,
 * trimmed and split like any other. @see shared/audioFx.ts
 *
 * With `existing` set, the section is editing a track that already IS an
 * effect: the same controls re-render it in place instead of stacking another.
 */
function SoundEffectsSection({
  sourceMediaId,
  inSec,
  outSec,
  startSec,
  linkGroupId,
  existing,
  replaceClipId,
  disabledReason
}: {
  sourceMediaId: string
  inSec: number
  outSec: number
  startSec: number
  linkGroupId?: string
  existing?: AudioFx | null
  replaceClipId?: string
  /** Non-null disables the section and says why (e.g. the clip has no audio). */
  disabledReason?: string | null
}): JSX.Element {
  const addFx = useAddAudioFx()
  const start = existing?.settings ?? null
  const [kind, setKind] = useState<AudioFxKind>(start?.kind ?? 'echo')
  const [echo, setEcho] = useState<EchoEffect>(
    start?.kind === 'echo' ? start.echo : { ...DEFAULT_ECHO }
  )
  const [ensemble, setEnsemble] = useState<EnsembleEffect>(
    start?.kind === 'ensemble' ? start.ensemble : { ...DEFAULT_ENSEMBLE }
  )
  const [chorus, setChorus] = useState<ChorusEffect>(
    start?.kind === 'chorus' ? start.chorus : { ...DEFAULT_CHORUS }
  )
  const settings: AudioFxSettings =
    kind === 'echo'
      ? { kind: 'echo', echo }
      : kind === 'ensemble'
        ? { kind: 'ensemble', ensemble }
        : { kind: 'chorus', chorus }
  const busy = addFx.isPending
  const disabled = !!disabledReason || busy

  // The render is content-addressed, so re-rendering settings that are already
  // on disk legitimately produces the SAME asset and changes nothing audible.
  // Without saying so, that is indistinguishable from a failed render — report
  // it. The note is tied to the settings it describes so it disappears as soon
  // as a knob moves.
  const [note, setNote] = useState<{ text: string; sig: string } | null>(null)
  const sig = JSON.stringify(settings)

  const run = (): void => {
    const before = replaceClipId
      ? activeComp(useProject.getState())?.audioClips.find((c) => c.id === replaceClipId)?.mediaId
      : undefined
    setNote(null)
    addFx.mutate(
      { settings, sourceMediaId, inSec, outSec, startSec, linkGroupId, replaceClipId },
      {
        onSuccess: (asset) =>
          setNote({
            sig,
            text:
              before && asset.id === before
                ? 'Already up to date — this is exactly what is rendered.'
                : existing
                  ? 'Re-rendered.'
                  : 'Track added.'
          })
      }
    )
  }

  return (
    <CollapsibleSection id="soundfx" title="Sound effects">
      {disabledReason && <p className="mb-2 text-[10px] leading-snug text-amber-300/80">{disabledReason}</p>}
      <div className="mb-2 flex gap-1">
        {FX_KINDS.map((k) => (
          <button
            key={k.value}
            onClick={() => setKind(k.value)}
            disabled={disabled}
            title={k.hint}
            className={`flex-1 rounded px-2 py-1 text-xs disabled:opacity-50 ${
              kind === k.value ? 'bg-sky-500/80 text-white' : 'bg-white/10 text-zinc-300 hover:bg-white/20'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="mb-2 text-[10px] leading-snug text-zinc-500">
        {FX_KINDS.find((k) => k.value === kind)?.hint}
      </p>

      {kind === 'echo' ? (
        <>
          <Field label={`Delay · ${Math.round(echo.delayMs)} ms`}>
            <input
              type="range"
              min={ECHO_RANGE.delayMs.min}
              max={ECHO_RANGE.delayMs.max}
              step={10}
              value={echo.delayMs}
              disabled={disabled}
              onChange={(e) => setEcho({ ...echo, delayMs: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Decay · ${echo.decay.toFixed(2)}`}>
            <input
              type="range"
              min={ECHO_RANGE.decay.min}
              max={ECHO_RANGE.decay.max}
              step={0.05}
              value={echo.decay}
              disabled={disabled}
              onChange={(e) => setEcho({ ...echo, decay: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Repeats · ${echo.repeats}`}>
            <input
              type="range"
              min={ECHO_RANGE.repeats.min}
              max={ECHO_RANGE.repeats.max}
              step={1}
              value={echo.repeats}
              disabled={disabled}
              onChange={(e) => setEcho({ ...echo, repeats: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
        </>
      ) : kind === 'ensemble' ? (
        <>
          <Field label={`Voices · ${ensemble.voices}`}>
            <input
              type="range"
              min={ENSEMBLE_RANGE.voices.min}
              max={ENSEMBLE_RANGE.voices.max}
              step={1}
              value={ensemble.voices}
              disabled={disabled}
              onChange={(e) => setEnsemble({ ...ensemble, voices: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Spread · ${Math.round(ensemble.spreadMs)} ms`}>
            <input
              type="range"
              min={ENSEMBLE_RANGE.spreadMs.min}
              max={ENSEMBLE_RANGE.spreadMs.max}
              step={1}
              value={ensemble.spreadMs}
              disabled={disabled}
              onChange={(e) => setEnsemble({ ...ensemble, spreadMs: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Detune · ${Math.round(ensemble.detuneCents)} cents`}>
            <input
              type="range"
              min={ENSEMBLE_RANGE.detuneCents.min}
              max={ENSEMBLE_RANGE.detuneCents.max}
              step={1}
              value={ensemble.detuneCents}
              disabled={disabled}
              onChange={(e) => setEnsemble({ ...ensemble, detuneCents: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={`Voices · ${chorus.voices}`}>
            <input
              type="range"
              min={CHORUS_RANGE.voices.min}
              max={CHORUS_RANGE.voices.max}
              step={1}
              value={chorus.voices}
              disabled={disabled}
              onChange={(e) => setChorus({ ...chorus, voices: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Rate · ${chorus.rateHz.toFixed(1)} Hz`}>
            <input
              type="range"
              min={CHORUS_RANGE.rateHz.min}
              max={CHORUS_RANGE.rateHz.max}
              step={0.1}
              value={chorus.rateHz}
              disabled={disabled}
              onChange={(e) => setChorus({ ...chorus, rateHz: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label={`Depth · ${chorus.depth.toFixed(2)}`}>
            <input
              type="range"
              min={CHORUS_RANGE.depth.min}
              max={CHORUS_RANGE.depth.max}
              step={0.05}
              value={chorus.depth}
              disabled={disabled}
              onChange={(e) => setChorus({ ...chorus, depth: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
        </>
      )}

      <button
        onClick={run}
        disabled={disabled}
        className={`mt-1 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 disabled:opacity-50 ${disabledCls}`}
        title={
          disabledReason ??
          (existing
            ? 'Re-render this effect track with the settings above'
            : 'Render the effect and add it as its own track over this clip')
        }
      >
        {busy
          ? 'Rendering…'
          : existing
            ? `↻ Re-render ${fxLabel(settings).toLowerCase()}`
            : `+ Add ${fxLabel(settings).toLowerCase()} track`}
      </button>
      {note && note.sig === sig ? (
        <p className="mt-1 text-[10px] leading-snug text-emerald-400/90">{note.text}</p>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-zinc-500">
          {existing
            ? 'Replaces this track’s audio in place.'
            : 'Adds a separate track — the original clip is left untouched.'}
        </p>
      )}
    </CollapsibleSection>
  )
}

/**
 * "Text effects" — decoration layered on top of the glyphs, deliberately
 * SEPARATE from the entrance/exit animation so the two combine freely: sparkles
 * plus a typewriter give letter-by-letter glints, sparkles plus a fade give a
 * shimmer, and any future effect here works with every entrance for free.
 *
 * Unlike animations, these are not lost on the rasterised-PNG path (gradient
 * fill / fixed wrap width) — sparkles burn as their own vector events above the
 * image — so there is no caveat to show here. @see shared/sparkle.ts
 */
function TextEffectsFields({
  content,
  onPatch
}: {
  content: TextContent
  onPatch: (patch: Partial<TextContent>) => void
}): JSX.Element {
  const sparkle = content.effects?.sparkle ?? null
  const on = !!sparkle && sparkle.density > 0
  const setSparkle = (next: SparkleEffect | null): void =>
    onPatch({ effects: { ...content.effects, sparkle: next } })

  return (
    <>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setSparkle(e.target.checked ? { ...DEFAULT_SPARKLE } : null)}
        />
        ✧ Sparkles
      </label>
      {on && sparkle && (
        <>
          <Field label={`Amount · ${sparkle.density}`}>
            <input
              type="range"
              min={SPARKLE_DENSITY_RANGE.min}
              max={SPARKLE_DENSITY_RANGE.max}
              step={1}
              value={sparkle.density}
              onChange={(e) => setSparkle({ ...sparkle, density: Number(e.target.value) })}
              className="w-full accent-sky-400"
            />
          </Field>
          <Field label="Color">
            <input
              type="color"
              value={sparkle.color.slice(0, 7)}
              onChange={(e) => setSparkle({ ...sparkle, color: e.target.value })}
              className={colorCls}
            />
          </Field>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">
            Follows a typewriter entrance letter by letter; scatters across the text with any
            other entrance.
          </p>
        </>
      )}
    </>
  )
}
