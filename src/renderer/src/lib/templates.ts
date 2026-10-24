/**
 * Dropping a template at the playhead, and making one from the selection
 * (shared/templates.ts holds the format). Pure over a `Composition`, like
 * `lib/links.ts` — the store wraps each in one commit.
 *
 * A drop with a clip effect turns the frame under the playhead into its own
 * HELD piece, and the timeline after it moves later by the hold:
 *
 *   ─── clip ───|──────── clip ────────     before (playhead at |)
 *   ─── clip ───|[held frame]|──── clip ─  after: the rest resumes after the hold
 *
 * The held piece is one source frame (`HOLD_FRAME_SEC`) with a freeze of
 * `holdSec` at its END — the hold shape verified against the export
 * (FFMPEG-NOTES "Freeze holds & overlay EOF"), never a zero-length source — so
 * the timeline grows by exactly the hold. Only that piece is zoomed and
 * graded, so the clip around it keeps its own look; it is silent (the template
 * brings its own sound). Every cut goes through `splitItemsAt` and every move
 * through `moveItemsBy`, so link groups, freezes and speed stay right.
 */

import type { AudioClip, Composition, Layer, TimelineItemRef, VideoContent } from '@shared/project'
import { isNeutralColor } from '@shared/project'
import { layerTransformAt, playedVideoDuration, videoTimelineTime } from '@shared/layers'
import { isNeutralTint } from '@shared/tint'
import {
  TEMPLATE_FORMAT_VERSION,
  cleanTemplateName,
  isTemplateLayer,
  type ReelTemplate,
  type TemplateAudio,
  type TemplateClipEffect
} from '@shared/templates'
import {
  expandGroup,
  linkItems,
  moveItemsBy,
  removeItems,
  splitItemsAt,
  timelineTiles,
  type SourceDuration
} from './links'

/** The held piece's own source length: one frame at 30 fps. */
export const HOLD_FRAME_SEC = 1 / 30

const EPS = 1e-3

export interface TemplateDrop {
  comp: Composition
  /** Every tile the drop added (the held frame first, when there is one). */
  added: TimelineItemRef[]
  /** The template has a clip effect but no clip was under the playhead, so
   *  only its overlay pieces landed. */
  effectSkipped: boolean
}

/** The video layer a clip effect applies to: the front-most visible video
 *  layer under timeline time `t` (null when none). */
export function clipUnder(comp: Composition, t: number): Layer | null {
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const l = comp.layers[i]
    if (l.content.kind === 'video' && !l.hidden && l.startSec <= t + EPS && t < l.endSec - EPS) return l
  }
  return null
}

/** The video layer the last split created: in `after` but not `before`, starting at `at`. */
function rightHalf(before: Composition, after: Composition, mediaId: string, at: number): Layer | null {
  const had = new Set(before.layers.map((l) => l.id))
  return (
    after.layers.find(
      (l) =>
        !had.has(l.id) && l.content.kind === 'video' && l.content.mediaId === mediaId && Math.abs(l.startSec - at) < EPS
    ) ?? null
  )
}

/**
 * Hold the frame under `atSec` for `fx.holdSec`, zoomed and graded, and push
 * everything that starts after it later by the hold. Returns the held layer's
 * id, or null (and `comp` unchanged) when no clip is under the playhead.
 */
export function applyClipEffect(
  comp: Composition,
  fx: TemplateClipEffect,
  atSec: number,
  srcDur: SourceDuration,
  makeId: () => string
): { comp: Composition; heldId: string | null } {
  const clip = clipUnder(comp, atSec)
  if (!clip || clip.content.kind !== 'video') return { comp, heldId: null }
  const mediaId = clip.content.mediaId
  // Where the frame is on screen at the drop point, before any cut re-bases it.
  const at = layerTransformAt(clip, atSec)

  // 1. Cut the clip (with its link group) at the drop point, unless it starts there.
  let c = comp
  let heldId = clip.id
  if (atSec > clip.startSec + EPS) {
    const before = c
    c = splitItemsAt(c, expandGroup(c, { kind: 'layer', id: clip.id }), atSec, srcDur, makeId)
    const right = rightHalf(before, c, mediaId, atSec)
    if (!right) return { comp, heldId: null }
    heldId = right.id
  }

  // 2. Cut one frame off the front of what follows: that frame becomes the held
  //    piece; its group's other one-frame slivers (the clip's own audio) go.
  const piece = c.layers.find((l) => l.id === heldId)!
  const cutAt = atSec + HOLD_FRAME_SEC
  if (piece.endSec > cutAt + EPS) {
    c = splitItemsAt(c, expandGroup(c, { kind: 'layer', id: heldId }), cutAt, srcDur, makeId)
  }
  const slivers = expandGroup(c, { kind: 'layer', id: heldId }).filter((r) => r.id !== heldId)
  c = removeItems(c, slivers)

  // 3. The held piece: silent, ungrouped, one frame then a freeze on it, graded.
  const cutLayer = c.layers.find((l) => l.id === heldId)!
  const cutEnd = cutLayer.endSec
  const vc = cutLayer.content as VideoContent
  const content: VideoContent = {
    ...vc,
    mute: true,
    speed: undefined,
    speedRamp: undefined,
    stabilize: null, // a one-frame window has nothing to stabilize
    freezes: undefined
  }
  content.freezes = [{ atSec: content.outSec, holdSec: fx.holdSec }]
  if (fx.color && !isNeutralColor(fx.color)) content.color = { ...fx.color }
  if (fx.tint && !isNeutralTint(fx.tint)) content.tint = { ...fx.tint }
  const holdLen = playedVideoDuration(content)
  const base = { x: at.x, y: at.y, scale: at.scale }
  const end = fx.zoom ? { x: at.x + fx.zoom.dx, y: at.y + fx.zoom.dy, scale: at.scale * fx.zoom.scale } : base
  const opacity = at.opacity < 1 ? { opacity: at.opacity } : {}
  const keyframes =
    fx.zoom || at.opacity < 1
      ? [
          { tSec: 0, ...base, ...opacity },
          { tSec: holdLen, ...end, ...opacity }
        ]
      : undefined
  const held: Layer = { ...cutLayer, ...base, endSec: cutLayer.startSec + holdLen, keyframes, content }
  delete held.linkGroupId
  c = { ...c, layers: c.layers.map((l) => (l.id === heldId ? held : l)) }

  // 4. Ripple: everything starting at or after the cut moves later by what the
  //    hold added, so the clip resumes after it and nothing gets covered.
  const delta = held.endSec - cutEnd
  const later = timelineTiles(c)
    .filter((t) => t.ref.id !== heldId && t.startSec >= cutEnd - EPS)
    .map((t) => t.ref)
  if (delta > EPS && later.length) c = moveItemsBy(c, later, delta)
  return { comp: c, heldId }
}

/** The template's pieces as new tiles at `atSec` (ids from `makeId`); a sound
 *  slot with no sound is skipped. Media references must already be library ids. */
function placedPieces(t: ReelTemplate, atSec: number, makeId: () => string): { layers: Layer[]; audio: AudioClip[] } {
  const layers = t.layers.filter(isTemplateLayer).map((l): Layer => {
    const copy: Layer = { ...l, id: makeId(), startSec: l.startSec + atSec, endSec: l.endSec + atSec }
    delete copy.linkGroupId
    return copy
  })
  const audio = t.audio.flatMap((a: TemplateAudio): AudioClip[] =>
    a.file ? [{ ...a.clip, id: makeId(), mediaId: a.file, startSec: a.clip.startSec + atSec }] : []
  )
  return { layers, audio }
}

/**
 * Drop `t` (its media already library ids — `mapTemplateFiles`) at `atSec`:
 * the clip effect first (so its ripple doesn't move the new pieces), then the
 * overlays on top of the stack, all linked into one group so they move, trim
 * and delete together.
 */
export function applyTemplate(
  comp: Composition,
  t: ReelTemplate,
  atSec: number,
  srcDur: SourceDuration,
  makeId: () => string
): TemplateDrop {
  let c = comp
  const added: TimelineItemRef[] = []
  let effectSkipped = false
  if (t.clipEffect) {
    const res = applyClipEffect(c, t.clipEffect, atSec, srcDur, makeId)
    c = res.comp
    if (res.heldId) added.push({ kind: 'layer', id: res.heldId })
    else effectSkipped = true
  }
  const pieces = placedPieces(t, atSec, makeId)
  c = { ...c, layers: [...c.layers, ...pieces.layers], audioClips: [...c.audioClips, ...pieces.audio] }
  added.push(
    ...pieces.layers.map((l) => ({ kind: 'layer' as const, id: l.id })),
    ...pieces.audio.map((a) => ({ kind: 'audio' as const, id: a.id }))
  )
  if (added.length > 1) c = linkItems(c, added, makeId)
  return { comp: c, added, effectSkipped }
}

// --- Save as template --------------------------------------------------------

export interface TemplateCapture {
  /** Media references are LIBRARY ids here; main swaps them for files on save. */
  template: ReelTemplate
  /** What the selection held that a template can't carry, for the dialog. */
  skipped: string[]
}

/** Whether `l` is a held piece a template drop made: a frame or two of source
 *  with its freeze at the end. Its drop point is its start, not the hold's. */
const isHeldPiece = (c: VideoContent, atSec: number): boolean =>
  atSec >= c.outSec - EPS && c.outSec - c.inSec <= 2 * HOLD_FRAME_SEC + EPS

/** The clip effect a frozen video layer carries, and the timeline time its
 *  (first) hold starts at — the template's drop point. */
function captureEffect(l: Layer): { fx: TemplateClipEffect; originSec: number } | null {
  if (l.content.kind !== 'video') return null
  const c = l.content
  const hold = [...(c.freezes ?? [])].sort((a, b) => a.atSec - b.atSec).find((f) => f.holdSec > 0)
  if (!hold) return null
  const held = isHeldPiece(c, hold.atSec)
  const originSec = held ? l.startSec : videoTimelineTime(c, l, hold.atSec)
  const a = layerTransformAt(l, originSec)
  const b = layerTransformAt(l, held ? l.endSec : originSec + hold.holdSec)
  const zoomed = Math.abs(b.scale - a.scale) > 1e-6 || Math.abs(b.x - a.x) > 0.5 || Math.abs(b.y - a.y) > 0.5
  return {
    originSec,
    fx: {
      holdSec: hold.holdSec,
      zoom: zoomed && a.scale > 0 ? { scale: b.scale / a.scale, dx: b.x - a.x, dy: b.y - a.y } : null,
      color: c.color && !isNeutralColor(c.color) ? { ...c.color } : null,
      tint: c.tint && !isNeutralTint(c.tint) ? { ...c.tint } : null
    }
  }
}

/**
 * A template from the tiles in `refs`, or a reason it can't be made. Text,
 * graphics and image layers and sound clips are kept as they are; a FROZEN
 * video clip gives the clip effect (its first hold, the zoom across it, its
 * grade and tint) but never its footage. The drop point is that hold's start,
 * or else the earliest piece's start. Captions, a clip's own extracted audio,
 * layouts and compound clips are listed in `skipped`.
 */
export function templateFromSelection(
  comp: Composition,
  refs: TimelineItemRef[],
  name: string,
  id: string,
  audioLabel: (mediaId: string) => string
): TemplateCapture | { error: string } {
  const clean = cleanTemplateName(name)
  if (!clean) return { error: 'Give the template a name.' }
  const keys = new Set(refs.map((r) => `${r.kind}:${r.id}`))
  const has = (kind: string, rid: string): boolean => keys.has(`${kind}:${rid}`)
  const skipped: string[] = []

  let effect: { fx: TemplateClipEffect; originSec: number } | null = null
  const overlays: Layer[] = []
  for (const l of comp.layers) {
    if (!has('layer', l.id)) continue
    if (isTemplateLayer(l)) overlays.push(l)
    else if (l.content.kind === 'video') {
      const got: ReturnType<typeof captureEffect> = effect ? null : captureEffect(l)
      if (got) effect = got
      else skipped.push(effect ? 'a second video clip' : 'video footage (add a freeze frame to save its effect)')
    } else skipped.push(l.content.kind === 'layout' ? 'a layout' : 'a compound clip')
  }
  const sounds: AudioClip[] = []
  for (const a of comp.audioClips) {
    if (!has('audio', a.id)) continue
    if (a.kind === 'extracted') skipped.push("a clip's own audio")
    else sounds.push(a)
  }
  if (comp.captions.segments.some((s) => has('caption', s.id))) skipped.push('captions')

  if (!effect && !overlays.length && !sounds.length) {
    return { error: 'Select text, graphics, images, sounds or a frozen clip to save as a template.' }
  }
  const origin = effect?.originSec ?? Math.min(...overlays.map((l) => l.startSec), ...sounds.map((a) => a.startSec))

  const layers = overlays.map((l): Layer => {
    const copy: Layer = { ...l, startSec: l.startSec - origin, endSec: l.endSec - origin }
    delete copy.linkGroupId
    return copy
  })
  const audio = sounds.map((a): TemplateAudio => ({
    label: audioLabel(a.mediaId),
    file: a.mediaId,
    clip: {
      startSec: a.startSec - origin,
      inSec: a.inSec,
      outSec: a.outSec,
      gainDb: a.gainDb,
      mute: a.mute,
      fadeInSec: a.fadeInSec,
      fadeOutSec: a.fadeOutSec,
      duck: a.duck,
      kind: a.kind === 'fx' ? 'audio' : a.kind
    }
  }))
  return {
    template: {
      id,
      name: clean,
      formatVersion: TEMPLATE_FORMAT_VERSION,
      layers,
      audio,
      clipEffect: effect?.fx ?? null
    },
    skipped
  }
}
