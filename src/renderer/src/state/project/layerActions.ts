/** Project store slice: LAYERS in the active composition — adding them, their
 *  transform / content / crop / keyframes, layouts and compound clips, and the
 *  edits that swap or pull media out of a video layer. Speed and freezes,
 *  which re-time a clip, are in videoTimingActions.ts. */

import type { CropRect, ImageContent, Layer, LayoutCell, TextContent, VideoContent } from '@shared/project'
import { videoSpeed } from '@shared/project'
import {
  MAX_COMP_DEPTH,
  compDepth,
  compositionDuration,
  makeCompFromCell,
  makeCompFromLayer,
  resolveCompAtPath,
  updateCompAtPath,
  type CompPath
} from '@shared/compositions'
import {
  applyVisibleOrder,
  FRAME,
  layerTransformAt,
  makeVideoLayer,
  rebaseVideoContent,
  rescaleForAspect,
  upsertKeyframe,
  windowCoversVideo
} from '@shared/layers'
import { hasSpeedRamp } from '@shared/speed'
import { applyLayoutPreset, makeLayoutLayer } from '@shared/layouts'
import { kindInfo } from '@shared/layerKinds'
import { newId } from '@shared/ids'
import type { PlacedClip, SequencePlan } from '@shared/assistant/protocol'
import type { TextEdit, TextEditResult } from '@shared/assistant/onScreenText'
import { extractAudioPieces } from '@/lib/timeline'
import * as links from '@/lib/links'
import { applySequence, makeExtractedAudioClip } from '@/lib/sequence'
import { applyTextEdits } from '@/lib/textEdits'
import { useUi } from '@/state/ui'
import { useAppSettings } from '@/state/appSettings'
import { activeComp, mapLayer, mapVideoLayer, projectFormat, type Doc } from './core'

/** A partial patch over a layer's content (the caller guards the content kind).
 *  A union of partials rather than Record<string, unknown> so a typo'd field
 *  name fails typecheck instead of silently landing in the saved document. */
type ContentPatch = Partial<VideoContent> | Partial<ImageContent> | Partial<TextContent>

export interface LayerActions {
  /** Append a layer to the FRONT of the stack (top). */
  addLayer: (layer: Layer) => void
  /** Add a video layer (front) at `startSec`; optionally extract its audio.
   *  `aspect` (the clip's w/h) fits it to the project's frame; absent = scale 1. */
  addVideoLayer: (
    id: string,
    mediaId: string,
    startSec: number,
    durationSec: number,
    hasAudio?: boolean,
    aspect?: number
  ) => void
  /** Lay `plan.items` end-to-end (the assistant's `place_sequence`) as ONE
   *  undo step and return what was placed. Throws — changing nothing — when
   *  there is no project or an item is unusable. */
  addVideoSequence: (plan: SequencePlan) => PlacedClip[]
  /** Apply the assistant's `set_text` edits (create/patch text layers and
   *  captions, restyle the caption lane) as ONE undo step. Throws — changing
   *  nothing — when there is no project or any edit is invalid. */
  applyTextEdits: (edits: TextEdit[], srcDur?: links.SourceDuration) => TextEditResult[]
  /** Add an empty multi-clip layout layer (front) at `startSec`. */
  addLayoutLayer: (id: string, presetId: string, startSec: number) => void
  /** Re-shape a layout to another preset (cells keep media/trim by index). */
  setLayoutPreset: (id: string, presetId: string) => void
  /** Patch one cell of a layout layer (media / trim / mute). */
  updateLayoutCell: (id: string, cellIndex: number, patch: Partial<LayoutCell>) => void
  /** Convert a layout cell into a nested composition ("edit this panel"),
   *  seeded from the cell's clip (empty cell → empty comp). No-op when the
   *  cell already carries a comp or the depth cap would be exceeded. The
   *  caller then typically `enterComposition({ layerId, cellIndex })`. */
  convertCellToComp: (layerId: string, cellIndex: number) => void
  /** Convert a timeline LAYER into a compound clip: the layer moves into a new
   *  nested composition (zero-based) and is replaced in place by a compound
   *  layer spanning the same window. No-op past the depth cap, on a layer that
   *  is already a compound, or on a linked tile (the group would be split). */
  convertLayerToComp: (layerId: string) => void
  updateLayer: (id: string, patch: Partial<Layer>) => void
  updateLayerContent: (id: string, patch: ContentPatch) => void
  /** Set (or clear, with `null`) a video layer's crop. The crop reshapes the
   *  clip's aspect, so its scale follows (`rescaleForAspect`) to keep its size
   *  RELATIVE TO THE FRAME — "Crop to 16:9" fills a 16:9 frame the way "Crop to
   *  9:16" fills a Reel. `sourceAspect` is the uncropped source's w/h. */
  setVideoCrop: (id: string, crop: CropRect | null, sourceAspect: number) => void
  removeLayer: (id: string) => void
  toggleLayerHidden: (id: string) => void
  /** Reapply a new front→back order of the *visible* layers to the full stack. */
  reorderLayers: (visibleFrontToBack: string[]) => void
  /** Capture the layer's effective transform at timeline time `atSec` as a
   *  keyframe (upserting one already at that offset). Only kinds whose
   *  keyframes drive the transform (`LAYER_KINDS`: video and image). */
  addLayerKeyframe: (id: string, atSec: number) => void
  /** Remove the keyframe at `index` (in sorted order). */
  removeLayerKeyframe: (id: string, index: number) => void
  /** Set the opacity (0..1) of the keyframe at `index` (in sorted order). */
  setLayerKeyframeOpacity: (id: string, index: number, opacity: number) => void
  /** Drop all keyframes; the layer returns to its static base transform. */
  clearLayerKeyframes: (id: string) => void
  /** Pull a video layer's audio onto the audio track and mute the layer. */
  extractLayerAudio: (id: string) => void
  /**
   * Swap a finished background-removal matte in for the video layer it was made
   * from (`rebaseVideoContent`): same placement and timing, one undo step. The
   * job ran for minutes, so the layer is re-found by `path` + id and only
   * swapped while it still plays footage the matte covers (same source, trim
   * inside the matted window). Returns false — and changes nothing — otherwise.
   */
  applyBackgroundRemoval: (
    path: CompPath,
    layerId: string,
    matte: {
      sourceMediaId: string
      window: { startSec: number; durationSec: number }
      mediaId: string
      pixelScale: { x: number; y: number }
      size: { w: number; h: number }
    }
  ) => boolean
}

/** Keyframes sorted by time, as the Inspector lists them (indexes refer to this order). */
const sortedKeyframes = (l: Layer): NonNullable<Layer['keyframes']> =>
  [...(l.keyframes ?? [])].sort((a, b) => a.tSec - b.tSec)

export const layerActions = ({ get, commit, commitComp }: Doc): LayerActions => ({
  addLayer: (layer) => commitComp((p) => ({ ...p, layers: [...p.layers, layer] })),

  addVideoLayer: (id, mediaId, startSec, durationSec, hasAudio = false, aspect) =>
    commitComp((p) => {
      // A clip and the audio track pulled off it are ONE thing by default, so
      // the pair lands LINKED: move/trim/split/delete either and the other
      // follows (`lib/links.ts`). Unlink from the timeline bar to edit one.
      const linkGroupId = hasAudio ? newId() : undefined
      const frame = projectFormat(get()).frame
      const base = makeVideoLayer(id, mediaId, startSec, durationSec, { mute: hasAudio, frame, aspect })
      const layer = linkGroupId ? { ...base, linkGroupId } : base
      const audioClips = hasAudio
        ? [
            ...p.audioClips,
            makeExtractedAudioClip(
              newId(),
              mediaId,
              startSec,
              0,
              Math.max(0.1, durationSec),
              linkGroupId!,
              useAppSettings.getState().autoJoinDefaultLevel
            )
          ]
        : p.audioClips
      return { ...p, layers: [...p.layers, layer], audioClips }
    }),

  addVideoSequence: (plan) => {
    const comp = activeComp(get())
    if (!comp) throw new Error('Editor has no project open')
    // Build first (throws on a bad item before anything is committed), then
    // commit the finished composition as a single history entry.
    const result = applySequence(comp, plan, {
      frame: projectFormat(get()).frame,
      newId,
      autoJoinLevel: useAppSettings.getState().autoJoinDefaultLevel
    })
    commitComp(() => result.comp)
    return result.placed
  },

  applyTextEdits: (edits, srcDur) => {
    const comp = activeComp(get())
    if (!comp) throw new Error('Editor has no project open')
    // Same measure as get_text's durationSec (whole-source audio needs `srcDur`).
    const durationSec = compositionDuration(comp, srcDur)
    const result = applyTextEdits(comp, edits, { frame: projectFormat(get()).frame, newId, durationSec })
    commitComp(() => result.comp)
    return result.results
  },

  addLayoutLayer: (id, presetId, startSec) =>
    commitComp((p) => ({ ...p, layers: [...p.layers, makeLayoutLayer(id, presetId, startSec)] })),

  setLayoutPreset: (id, presetId) =>
    commitComp((p) =>
      mapLayer(p, id, (l) =>
        l.content.kind === 'layout' ? { ...l, content: applyLayoutPreset(l.content, presetId) } : l
      )
    ),

  updateLayoutCell: (id, cellIndex, patch) =>
    commitComp((p) =>
      mapLayer(p, id, (l) => {
        if (l.content.kind !== 'layout') return l
        const cells = l.content.cells.map((cell, i) => (i === cellIndex ? { ...cell, ...patch } : cell))
        return { ...l, content: { ...l.content, cells } }
      })
    ),

  convertCellToComp: (layerId, cellIndex) => {
    // Depth check against where the comp will LIVE (one below the active
    // comp): active depth = editPath.length + 1; the new comp sits one deeper.
    if (get().editPath.length + 2 > MAX_COMP_DEPTH) return
    commitComp((p) =>
      mapLayer(p, layerId, (l) => {
        if (l.content.kind !== 'layout') return l
        const cell = l.content.cells[cellIndex]
        if (!cell || cell.comp) return l
        const comp = makeCompFromCell(cell, newId)
        if (compDepth(comp) + get().editPath.length + 1 > MAX_COMP_DEPTH) return l
        const cells = l.content.cells.map((c, i) =>
          // The comp now owns the content; the single-clip fields stay behind
          // only as the seed's provenance (comp overrides them everywhere).
          // The cell-level mute OPENS: cells default to muted (four panels
          // shouting at once is chaos), but a comp mixes its own audio — per
          // clip and on its own lane — so leaving it shut would be a second,
          // invisible gate over those choices. The seeded clip keeps the old
          // mute, so converting alone changes nothing you can hear.
          i === cellIndex ? { ...c, comp, mediaId: null, mute: false } : c
        )
        return { ...l, content: { ...l.content, cells } }
      })
    )
  },

  convertLayerToComp: (layerId) => {
    if (get().editPath.length + 2 > MAX_COMP_DEPTH) return
    commitComp((p) =>
      mapLayer(p, layerId, (l) => {
        if (l.content.kind === 'compound') return l
        // A linked tile moves with partners that would stay behind.
        if (l.linkGroupId && links.isLinked(p, { kind: 'layer', id: layerId })) return l
        const comp = makeCompFromLayer(l)
        if (compDepth(comp) + get().editPath.length + 1 > MAX_COMP_DEPTH) return l
        // Same window and stack slot; the transform resets because the comp
        // renders as a full frame (its inner layer keeps the old transform).
        return {
          id: l.id,
          hidden: l.hidden,
          startSec: l.startSec,
          endSec: l.endSec,
          x: FRAME.width / 2,
          y: FRAME.height / 2,
          scale: 1,
          content: { kind: 'compound', comp }
        }
      })
    )
  },

  updateLayer: (id, patch) => commitComp((p) => mapLayer(p, id, (l) => ({ ...l, ...patch }))),

  updateLayerContent: (id, patch) =>
    commitComp((p) => mapLayer(p, id, (l) => ({ ...l, content: { ...l.content, ...patch } as Layer['content'] }))),

  setVideoCrop: (id, crop, sourceAspect) => {
    const frame = projectFormat(get()).frame
    commitComp((p) =>
      mapVideoLayer(p, id, (l, c) => {
        const from = c.crop ? c.crop.w / c.crop.h : sourceAspect
        const to = crop ? crop.w / crop.h : sourceAspect
        return { ...rescaleForAspect(l, from, to, frame), content: { ...c, crop } }
      })
    )
  },

  removeLayer: (id) => {
    commitComp((p) => links.removeItems(p, [{ kind: 'layer', id }]))
    if (useUi.getState().selectedLayerId === id) useUi.getState().selectLayer(null)
  },

  toggleLayerHidden: (id) => commitComp((p) => mapLayer(p, id, (l) => ({ ...l, hidden: !l.hidden }))),

  reorderLayers: (visibleFrontToBack) =>
    commitComp((p) => ({ ...p, layers: applyVisibleOrder(p.layers, [...visibleFrontToBack].reverse()) })),

  addLayerKeyframe: (id, atSec) =>
    commitComp((p) =>
      mapLayer(p, id, (l) => {
        // Only kinds whose keyframes drive the transform (LAYER_KINDS): text
        // moves along a path, layouts and compound clips have no export keyframe path.
        if (kindInfo(l).keyframes !== 'transform') return l
        const tSec = Math.max(0, Math.min(atSec - l.startSec, Math.max(0, l.endSec - l.startSec)))
        // Full opacity is stored as ABSENCE so untouched keyframes keep the
        // plain (opaque) pipeline on export.
        const { opacity, ...tr } = layerTransformAt(l, atSec)
        return {
          ...l,
          keyframes: upsertKeyframe(l.keyframes, {
            tSec,
            ...tr,
            ...(opacity < 0.9995 ? { opacity } : {})
          })
        }
      })
    ),

  removeLayerKeyframe: (id, index) =>
    commitComp((p) =>
      mapLayer(p, id, (l) => {
        const kfs = sortedKeyframes(l)
        if (!kfs[index]) return l
        const next = kfs.filter((_, i) => i !== index)
        return { ...l, keyframes: next.length ? next : undefined }
      })
    ),

  setLayerKeyframeOpacity: (id, index, opacity) =>
    commitComp((p) =>
      mapLayer(p, id, (l) => {
        const kfs = sortedKeyframes(l)
        if (!kfs[index]) return l
        const o = Math.min(1, Math.max(0, opacity))
        // Store 1 as absence so untouched keyframes keep the plain pipeline.
        kfs[index] = { ...kfs[index], opacity: o >= 0.9995 ? undefined : o }
        return { ...l, keyframes: kfs }
      })
    ),

  clearLayerKeyframes: (id) => commitComp((p) => mapLayer(p, id, (l) => ({ ...l, keyframes: undefined }))),

  extractLayerAudio: (id) =>
    commitComp((p) => {
      const layer = p.layers.find((l) => l.id === id)
      if (!layer || layer.content.kind !== 'video') return p
      // A re-timed clip's audio can't be detached to the (1×) audio lane —
      // the AudioClip model has no tempo. The Inspector disables the action.
      if (videoSpeed(layer.content) !== 1 || hasSpeedRamp(layer.content)) return p
      const c = layer.content
      // Freeze holds split the audio into pieces with silent gaps so the dialogue
      // cuts while a frame is held (and stays synced to the stretched video).
      const pieces = extractAudioPieces(layer, c, newId, useAppSettings.getState().autoJoinDefaultLevel)
      return {
        ...mapLayer(p, id, (l) => ({ ...l, content: { ...c, mute: true } })),
        audioClips: [...p.audioClips, ...pieces]
      }
    }),

  applyBackgroundRemoval: (path, layerId, matte) => {
    const { window } = matte
    let applied = false
    commit((p) => {
      const c = resolveCompAtPath(p, path)?.layers.find((l) => l.id === layerId)?.content
      if (c?.kind !== 'video' || !windowCoversVideo(c, matte.sourceMediaId, window)) return p
      applied = true
      return updateCompAtPath(p, path, (comp) =>
        mapVideoLayer(comp, layerId, (l, video) => ({
          ...l,
          content: rebaseVideoContent(video, matte.mediaId, window.startSec, matte.pixelScale, matte.size)
        }))
      )
    })
    return applied
  }
})
