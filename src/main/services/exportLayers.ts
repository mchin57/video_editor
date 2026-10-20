/**
 * One exporter per layer kind: each turns a visible layer into compositor
 * steps on a `CompositionRender` (its visuals, its audio). `exportLayer`
 * dispatches with an exhaustive switch, so a new layer kind without an
 * exporter doesn't compile. Text layers live in exportText.ts with captions —
 * the two are one thing (docs/SHARED.md "Burned text").
 */

import type { CellRect, CompoundContent, ImageContent, Layer, LayoutContent, VideoContent } from '@shared/project'
import { effectiveStabilize, isNeutralColor, videoSpeed } from '@shared/project'
import { assertNever } from '@shared/layerKinds'
import { hasSpeedRamp, speedSegments } from '@shared/speed'
import { cellSpan, coverCrop, FULL_CELL, layoutCellRect } from '@shared/layouts'
import { alphaInputDecoder } from '@shared/media'
import { effectiveImageAspect, FRAME, stretchedBox } from '@shared/layers'
import { existsSync } from 'node:fs'
import { ensureImagePath, getAsset } from './mediaStore'
import { hdrToSdrChain } from './proxy'
import { eqFilter, r } from './ffmpegFilters'
import type { ExportVideo } from './exporterArgs'
import type { CompositionRender, Prerendered } from './exportRender'
import { exportTextLayer } from './exportText'

/** Add a visible layer's compositor steps to the pass. */
export function exportLayer(pass: CompositionRender, l: Layer): Promise<void> {
  const c = l.content
  switch (c.kind) {
    case 'video':
      return exportVideoLayer(pass, l, c)
    case 'image':
      return exportImageLayer(pass, l, c)
    case 'layout':
      return exportLayoutLayer(pass, l, c)
    case 'compound':
      return exportCompoundLayer(pass, l, c)
    case 'text':
      return exportTextLayer(pass, l, c)
    default:
      return assertNever(c, 'layer kind')
  }
}

async function exportVideoLayer(pass: CompositionRender, l: Layer, c: VideoContent): Promise<void> {
  const { ctx, m, s } = pass
  const asset = await getAsset(c.mediaId, ctx.session)
  if (!asset) throw new Error(`Missing source media for a layer (${c.mediaId}).`)
  const v = asset.probe.video
  const aspect = c.crop
    ? c.crop.w / c.crop.h
    : v && v.displayHeight > 0
      ? v.displayWidth / v.displayHeight
      : FRAME.width / FRAME.height
  const box = stretchedBox(aspect, l.scale, l.stretchX ?? 1, l.stretchY ?? 1)
  const boxW = box.w * s
  const boxH = box.h * s
  const trimLen = Math.max(0.01, c.outSec - c.inSec)
  // Stabilization (clip override, else project default) pre-renders a
  // trimmed, SDR, stabilized intermediate; the composite then reads it from
  // 0 with the tonemap already applied.
  let srcPath = asset.originalPath
  let srcInSec = c.inSec
  let hdrChain = v?.isHdr ? hdrToSdrChain(v) : ''
  let hasAlpha = !!v?.hasAlpha
  let inputDecoder = alphaInputDecoder(v)
  let stab = effectiveStabilize(c, ctx.stabilizeDefault)
  if (stab && ctx.stills) {
    ctx.stills.skippedStabilize = true
    stab = null
  }
  if (stab) {
    srcPath = await pass.stabilize(asset.originalPath, c.inSec, trimLen, hdrChain, stab)
    srcInSec = 0
    hdrChain = ''
    // The stabilized intermediate is an opaque yuv420p mp4 — any alpha is gone.
    hasAlpha = false
    inputDecoder = null
  }
  pass.visuals.push({
    kind: 'video',
    video: {
      path: srcPath,
      inSec: srcInSec,
      len: trimLen,
      hdrChain,
      hasAlpha,
      inputDecoder,
      crop: c.crop ?? null,
      flipH: c.flipH,
      flipV: c.flipV,
      rotationDeg: l.rotationDeg,
      colorEq: isNeutralColor(c.color) ? '' : eqFilter(c.color!),
      boxW,
      boxH,
      x: r(m.x(l.x) - boxW / 2),
      y: r(m.y(l.y) - boxH / 2),
      startSec: l.startSec,
      endSec: l.endSec,
      freezes: (c.freezes ?? []).map((f) => ({ atLocal: f.atSec - c.inSec, holdSec: f.holdSec })),
      speed: videoSpeed(c),
      // Speed-ramp profile → boundary points in trimmed-input time. The
      // shared `speedSegments` resolves the same profile the preview plays.
      ramp: hasSpeedRamp(c) ? rampPoints(c) : undefined,
      keyframes: pass.keyframes(l, aspect),
      opacity: await pass.opacityAnim(l)
    }
  })
  // An unmuted video layer's own audio joins the mix (placed at its start),
  // tempo-matched to the clip's speed (pitch-preserving atempo chain). A
  // RAMPED clip's audio is dropped — there is no variable-tempo audio path,
  // and the preview mutes it too so both sides agree.
  if (!c.mute && asset.probe.audio && !hasSpeedRamp(c)) {
    pass.audio.push({
      path: asset.originalPath,
      inSec: c.inSec,
      outSec: c.outSec,
      startSec: l.startSec,
      gainDb: c.gainDb,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      foldChannel: asset.probe.audio.monoFoldChannel ?? null,
      tempo: videoSpeed(c)
    })
  }
}

/** A speed ramp as boundary points in trimmed-input time. */
function rampPoints(c: VideoContent): { u: number; v: number }[] {
  const segs = speedSegments(c, c.inSec, c.outSec)
  return [
    ...segs.map((seg) => ({ u: seg.s0 - c.inSec, v: seg.v0 })),
    { u: segs[segs.length - 1].s1 - c.inSec, v: segs[segs.length - 1].v1 }
  ]
}

async function exportImageLayer(pass: CompositionRender, l: Layer, c: ImageContent): Promise<void> {
  const { ctx, m, s } = pass
  const imgPath = await ensureImagePath(c.mediaId, ctx.session)
  if (!existsSync(imgPath)) return // display PNG missing → skip rather than fail
  const v = (await getAsset(c.mediaId, ctx.session))?.probe.video
  const base = v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 1
  // base aspect, reshaped by crop, swapped for 90°/270° rotation (shared helper).
  const aspect = effectiveImageAspect(base, c.crop, c.rotateQuarters)
  const q = (((c.rotateQuarters ?? 0) % 4) + 4) % 4
  const box = stretchedBox(aspect, l.scale, l.stretchX ?? 1, l.stretchY ?? 1)
  const boxW = box.w * s
  const boxH = box.h * s
  pass.visuals.push({
    kind: 'image',
    image: {
      path: imgPath,
      boxW,
      boxH,
      x: r(m.x(l.x) - boxW / 2),
      y: r(m.y(l.y) - boxH / 2),
      startSec: l.startSec,
      endSec: l.endSec,
      opacity: c.opacity,
      crop: c.crop ?? null,
      rotateQuarters: q,
      flipH: c.flipH,
      flipV: c.flipV,
      rotationDeg: l.rotationDeg,
      keyframes: pass.keyframes(l, aspect),
      opacityAnim: await pass.opacityAnim(l, c.opacity)
    }
  })
}

/** The source of a clip placed in a frame region (a layout cell or a compound
 *  clip's frame): no transform of its own, 1×, cover-cropped by the caller. */
type PlacedSource = Pick<ExportVideo, 'path' | 'inSec' | 'hdrChain' | 'hasAlpha' | 'inputDecoder' | 'crop'>

/** A clip filling `rect` (canonical px) for `span` seconds from the layer's start. */
function placeInRect(pass: CompositionRender, l: Layer, rect: CellRect, span: number, src: PlacedSource): void {
  const { m, s } = pass
  pass.visuals.push({
    kind: 'video',
    video: {
      ...src,
      len: span,
      colorEq: '',
      boxW: rect.w * s,
      boxH: rect.h * s,
      x: r(m.x(rect.x)),
      y: r(m.y(rect.y)),
      startSec: l.startSec,
      endSec: l.startSec + span,
      freezes: [],
      speed: 1
    }
  })
}

/** That clip's audio, at unity gain, over the same span. */
function placeAudio(
  pass: CompositionRender,
  l: Layer,
  path: string,
  inSec: number,
  span: number,
  foldChannel: number | null
): void {
  pass.audio.push({
    path,
    inSec,
    outSec: inSec + span,
    startSec: l.startSec,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    foldChannel
  })
}

/** A pre-rendered comp as a placed source: a transparent VP9 intermediate (its
 *  alpha is a side-band the native decoder drops — force libvpx). */
const prerenderedSource = (pre: Prerendered, crop: ExportVideo['crop']): PlacedSource => ({
  path: pre.path,
  inSec: 0,
  hdrChain: '',
  hasAlpha: true,
  inputDecoder: 'libvpx-vp9',
  crop
})

/**
 * Each cell compiles to an ORDINARY compositor video entry (already-verified
 * crop→scale→overlay path): cover-cropped to its cell rect, playing 1× from the
 * layout's start, time-gated to the shorter of the cell span and the layer
 * window (audio clamps the same way so it can't outlive the video). Cells
 * composite in array order within the layer's z-slot; empty cells let lower
 * layers show through.
 */
async function exportLayoutLayer(pass: CompositionRender, l: Layer, c: LayoutContent): Promise<void> {
  const { ctx, frame } = pass
  const window = Math.max(0, l.endSec - l.startSec)
  for (const cell of c.cells) {
    // A cell carrying a composition renders that comp (pre-rendered to a
    // transparent intermediate) cover-cropped into the panel, exactly like
    // a single clip would be — the comp OVERRIDES mediaId.
    if (cell.comp) {
      const pre = await pass.prerender(cell.comp)
      if (!pre) continue
      const rect = layoutCellRect(l, cell.rect, frame)
      if (rect.w <= 0 || rect.h <= 0) continue
      const span = Math.min(pre.len, window)
      if (span <= 0.01) continue
      // The comp renders at the full output frame, so cover-crop it to the
      // cell the same way a source clip is cropped.
      const crop = coverCrop(ctx.target.width, ctx.target.height, rect.w / rect.h)
      placeInRect(pass, l, rect, span, prerenderedSource(pre, crop))
      if (!cell.mute && pre.hasAudio) placeAudio(pass, l, pre.path, 0, span, null)
      continue
    }
    if (!cell.mediaId) continue
    const span = Math.min(cellSpan(cell), window)
    if (span <= 0.01) continue
    const asset = await getAsset(cell.mediaId, ctx.session)
    if (!asset?.probe.video) continue
    const v = asset.probe.video
    const rect = layoutCellRect(l, cell.rect, frame)
    if (rect.w <= 0 || rect.h <= 0) continue
    placeInRect(pass, l, rect, span, {
      path: asset.originalPath,
      inSec: cell.inSec,
      hdrChain: v.isHdr ? hdrToSdrChain(v) : '',
      hasAlpha: !!v.hasAlpha,
      inputDecoder: alphaInputDecoder(v),
      crop: coverCrop(v.displayWidth, v.displayHeight, rect.w / rect.h)
    })
    if (!cell.mute && asset.probe.audio) {
      placeAudio(pass, l, asset.originalPath, cell.inSec, span, asset.probe.audio.monoFoldChannel ?? null)
    }
  }
}

/**
 * A compound clip is its composition, pre-rendered to a transparent
 * intermediate and composited as an ordinary full-frame video input — the same
 * geometry rule as a layout (the layer transform moves/zooms the whole comp
 * frame), matching the preview's CompFill.
 */
async function exportCompoundLayer(pass: CompositionRender, l: Layer, c: CompoundContent): Promise<void> {
  const pre = await pass.prerender(c.comp)
  if (!pre) return
  const rect = layoutCellRect(l, FULL_CELL, pass.frame)
  if (rect.w <= 0 || rect.h <= 0) return
  const span = Math.min(pre.len, Math.max(0, l.endSec - l.startSec))
  if (span <= 0.01) return
  placeInRect(pass, l, rect, span, prerenderedSource(pre, null))
  if (pre.hasAudio) placeAudio(pass, l, pre.path, 0, span, null)
}
