/** Inspector ▸ video layer: everything only a video clip has — trim, audio,
 *  speed, crop, stills, sound effects, freeze frames, colour, stabilization
 *  and background removal. */

import { type JSX } from 'react'
import type { Composition, Layer, VideoContent } from '@shared/project'
import { DEFAULT_STABILIZE, NEUTRAL_COLOR, effectiveStabilize, isNeutralColor, videoSpeed } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { assetAspect } from '@shared/media'
import { hasSpeedRamp } from '@shared/speed'
import { projectFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { formatDuration, formatFps } from '@/lib/format'
import { CollapsibleSection } from '../CollapsibleSection'
import { Field, NumberInput, Row, disabledCls, inputCls } from '../ui'
import { LiveRange, OverrideToggle, StabilizeSliders, setLayer, type TriMode } from './controls'
import { RemoveBackground } from './RemoveBackground'
import { PoseSection } from './PoseSection'
import { FreezeFrames, SpeedControl } from './VideoTiming'
import { SoundEffectsSection } from './SoundEffects'

export function VideoClipSections({
  layer,
  content: c,
  asset,
  linked
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset | undefined
  /** In a link group: edits that re-time one member are disabled. */
  linked: boolean
}): JSX.Element {
  const id = layer.id
  const updateContent = useProject((s) => s.updateLayerContent)
  const extractAudio = useProject((s) => s.extractLayerAudio)
  const setVideoCrop = useProject((s) => s.setVideoCrop)
  const format = useProject(projectFormat)
  const setCropEditing = useUi((s) => s.setCropEditing)
  const setStillsOpen = useUi((s) => s.setStillsOpen)
  const retimed = videoSpeed(c) !== 1 || hasSpeedRamp(c)

  return (
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
              disabled={retimed || linked}
              className={`rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/20 ${disabledCls}`}
              title={
                retimed
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

      <ColorSection layerId={id} content={c} />
      <StabilizeSection layerId={id} content={c} />

      {/* Background removal → this clip's segment, matted and swapped in
          place. An already-transparent clip just says so. */}
      <RemoveBackground key={`matte-${id}`} layerId={id} content={c} asset={asset} />
      <PoseSection key={`pose-${id}`} layer={layer} content={c} asset={asset} />
    </>
  )
}

/** Exposure / contrast / saturation, live while dragging (one undo step each). */
function ColorSection({ layerId, content: c }: { layerId: string; content: VideoContent }): JSX.Element {
  const updateContent = useProject((s) => s.updateLayerContent)
  const mut = setLayer(layerId)
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
    <CollapsibleSection
      id="color"
      title="Color"
      right={
        !isNeutralColor(c.color) ? (
          <button
            onClick={() => updateContent(layerId, { color: undefined })}
            className="text-[10px] text-zinc-400 hover:text-zinc-200"
          >
            Reset
          </button>
        ) : null
      }
    >
      <Field label={`Exposure  ${col.brightness >= 0 ? '+' : ''}${col.brightness.toFixed(2)}`}>
        <LiveRange min={-0.5} max={0.5} step={0.02} value={col.brightness} transform={setCol('brightness')} />
      </Field>
      <Field label={`Contrast  ${col.contrast.toFixed(2)}`}>
        <LiveRange min={0.5} max={1.8} step={0.02} value={col.contrast} transform={setCol('contrast')} />
      </Field>
      <Field label={`Saturation  ${col.saturation.toFixed(2)}`}>
        <LiveRange min={0} max={2} step={0.02} value={col.saturation} transform={setCol('saturation')} />
      </Field>
    </CollapsibleSection>
  )
}

/** Stabilization: the project default, or this clip forced on / off. */
function StabilizeSection({ layerId, content: c }: { layerId: string; content: VideoContent }): JSX.Element {
  const updateContent = useProject((s) => s.updateLayerContent)
  const stabilizeDefault = useProject((s) => s.project?.stabilizeDefault ?? null)
  const eff = effectiveStabilize(c, stabilizeDefault)
  const mode: TriMode = c.stabilize === undefined ? 'default' : c.stabilize ? 'on' : 'off'
  return (
    <CollapsibleSection
      id="stabilize"
      title="Stabilization"
      right={
        c.stabilize !== undefined ? (
          <button
            onClick={() => updateContent(layerId, { stabilize: undefined })}
            className="text-[10px] text-zinc-400 hover:text-zinc-200"
          >
            Reset
          </button>
        ) : null
      }
    >
      <OverrideToggle
        label="Stabilize motion (on export)"
        noun="stabilization"
        effectiveOn={!!eff}
        defaultOn={!!stabilizeDefault}
        mode={mode}
        onPick={(key) =>
          updateContent(layerId, {
            stabilize: key === 'default' ? undefined : key === 'off' ? null : { ...(eff ?? DEFAULT_STABILIZE) }
          })
        }
      />
      {c.stabilize && (
        <StabilizeSliders value={c.stabilize} onChange={(next) => updateContent(layerId, { stabilize: next })} />
      )}
      <p className="text-[10px] leading-snug text-zinc-500">
        Analysed and rendered on export (a two-pass stabilize); higher smoothing is steadier but crops in more. Preview
        is unaffected.
      </p>
    </CollapsibleSection>
  )
}
