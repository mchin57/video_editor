/** Inspector ▸ the selected LAYER (video, image, text, layout, compound clip). */

import { type JSX } from 'react'
import { layerFitScale } from '@shared/layers'
import { assetAspect } from '@shared/media'
import { kindInfo, layerMediaId } from '@shared/layerKinds'
import { useLibrary } from '@/hooks/useMedia'
import { activeComp, projectFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { CollapsibleSection } from '../CollapsibleSection'
import { TextStyleControls } from '../TextStyleControls'
import { LayoutCells } from '../LayoutCells'
import { AngleField, Field, NumberInput, dangerBtnCls, disabledCls, inputCls, toggleCls } from '../ui'
import { useLinkGroupSize, useMaxEndSec, LinkedNote, useDeleteTile, LiveRange, setLayer } from './controls'
import { MotionFields, KeyframesSection } from './Motion'
import { TextAnimationFields, LayerTextInput, TextEffectsFields } from './TextFields'
import { VideoClipSections } from './VideoSections'

export function LayerEditor(): JSX.Element | null {
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const layer = useProject((s) => activeComp(s)?.layers.find((l) => l.id === selectedLayerId) ?? null)
  const update = useProject((s) => s.updateLayer)
  const updateContent = useProject((s) => s.updateLayerContent)
  const groupSize = useLinkGroupSize('layer', selectedLayerId)
  const linked = groupSize > 1
  const remove = useDeleteTile('layer', selectedLayerId)
  const setImageEditOpen = useUi((s) => s.setImageEditOpen)
  const format = useProject(projectFormat)
  const { data: assets = [] } = useLibrary()
  const maxEnd = useMaxEndSec(selectedLayerId)
  if (!layer) return null
  const id = layer.id
  const mut = setLayer(id)
  const c = layer.content
  const kind = kindInfo(layer)
  const mediaId = layerMediaId(c)
  const asset = mediaId ? assets.find((a) => a.id === mediaId) : undefined
  // Position and zoom READ frame-relative (0,0 = the frame's top-left, 100% =
  // fits the frame); the document stays in canonical coords, so a format switch
  // never rewrites them. Identity in 9:16.
  const frame = format.frame
  const zoomBase = layerFitScale(layer, assetAspect(asset), frame)
  // Keyframes override the base transform for media layers; grey those fields.
  // A text layer's keyframes are its straight-line motion: they own its
  // POSITION only (its size is never keyframed).
  const hasKfs = (layer.keyframes?.length ?? 0) > 0
  const keyframed = kind.keyframes === 'transform' && hasKfs
  const posKeyframed = keyframed || (kind.keyframes === 'path' && hasKfs)

  return (
    <div>
      <div className="mb-1 text-sm font-medium text-zinc-200" data-testid="inspector-kind">
        {kind.title}
      </div>
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
        {kind.rotatable && (
          <AngleField
            value={layer.rotationDeg ?? 0}
            onChange={(deg) => update(id, { rotationDeg: deg || undefined })}
          />
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
      {kind.motion && (
        <CollapsibleSection id="motion" title="Motion">
          <MotionFields layer={layer} frame={frame} />
        </CollapsibleSection>
      )}

      {/* Keyframed motion (video/image; text animates via its own presets;
          layouts and compounds have no export keyframe path) */}
      {kind.keyframes === 'transform' && (
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
            The aspect ratio is set in the <span className="text-zinc-400">Format</span> menu. Cells fill their panel
            (center-cropped) and play at 1× from the layout&apos;s start.
          </p>
        </CollapsibleSection>
      )}

      {/* Compound clip: a whole nested timeline standing in for one clip. */}
      {c.kind === 'compound' && (
        <CollapsibleSection id="compound" title="Compound clip">
          <CompoundControls layerId={id} />
        </CollapsibleSection>
      )}

      {c.kind === 'video' && <VideoClipSections layer={layer} content={c} asset={asset} linked={linked} />}

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
            <LayerTextInput value={c.text} onChange={(text) => updateContent(id, { text })} />
          </Field>
          <TextStyleControls
            style={c}
            onPatch={(patch) => updateContent(id, patch)}
            animation={c.animation ?? null}
            onApplyStyle={(st, anim) => updateContent(id, anim !== undefined ? { ...st, animation: anim } : st)}
          />
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
        A compound clip is a whole timeline standing in for one clip — cut it, mix its audio, colour-grade it, layer
        text over it. Its result plays here from this block&apos;s start.
      </p>
    </>
  )
}
