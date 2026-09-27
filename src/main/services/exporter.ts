/**
 * Export orchestrator: composites the unified layer stack in a SINGLE ffmpeg
 * pass (black base canvas → overlay each visual layer in z-order → mix audio →
 * encode). Several video layers play at once, each scaled/positioned to its
 * layer transform and time-gated to its window; text layers burn via per-layer
 * ASS so the full back-to-front order is honored. Exports from the ORIGINAL
 * media. Progress is the single encode's progress over the project duration.
 */

import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CaptionStyle, Composition, Project, Stabilize } from '@shared/project'
import {
  audioClipAudible,
  effectiveDenoise,
  effectiveOut,
  effectiveStabilize,
  isNeutralColor,
  videoSpeed
} from '@shared/project'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import { compositionDuration, MAX_COMP_DEPTH } from '@shared/compositions'
import { hasSpeedRamp, speedSegments } from '@shared/speed'
import { cellSpan, coverCrop, FULL_CELL, layoutCellRect } from '@shared/layouts'
import { clampAnimWindows, effectiveTextAnimation } from '@shared/textAnim'
import { activeSparkle, sparklesFor } from '@shared/sparkle'
import { presetFor, type PresetId } from '@shared/formats'
import { alphaInputDecoder } from '@shared/media'
import {
  effectiveImageAspect,
  FRAME,
  frameToOutput,
  opacityKeyframePoints,
  stretchedBox
} from '@shared/layers'
import type { Layer, TextContent } from '@shared/project'
import type { ExportKeyframe, OpacityAnim } from './exporterArgs'
import { getSubdir, getBundledFontsDir } from '../config'
import { getBinaries, getCapabilities } from './ffmpeg'
import { getAsset, imageAssetPath } from './mediaStore'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import {
  buildExportArgs,
  buildVidstabDetectArgs,
  buildVidstabTransformArgs,
  targetForPreset,
  type ExportAudio,
  type ExportImage,
  type ExportVisual,
  type StabilizeJob,
  type Target
} from './exporterArgs'
import { buildAss, type AssOverlay, type AssSparkle } from './assBuilder'
import { createTextRenderer, type TextRenderer } from './textImage'
import { decorationScale, scaledPill, scaledShadow, scaledStroke } from './textScale'
import { hdrToSdrChain } from './proxy'
import { runFfmpeg } from './ffmpegRun'
import { buildOpacityCmdLines, eqFilter, r } from './ffmpegFilters'

/** Canonical logical → output px for one render (`frameToOutput`). */
type OutputMap = ReturnType<typeof frameToOutput>

/**
 * An overlay carrying ONLY sparkles, for text whose glyphs burned as a PNG.
 * The text fields are inert — `buildAss` emits no text events for empty text —
 * but `AssOverlay` requires them, so they carry the layer's real values rather
 * than placeholders.
 */
function sparkleOnlyOverlay(c: TextContent, l: Layer, m: OutputMap): AssOverlay {
  return {
    text: '',
    startSec: l.startSec,
    endSec: l.endSec,
    x: r(m.x(l.x)),
    y: r(m.y(l.y)),
    anchor: 'center',
    fontFamily: c.fontFamily,
    fontSizePx: c.fontSizePx * l.scale * m.s,
    color: c.color,
    pill: c.pill
  }
}

/** A pre-rendered, output-sized PNG composited 1:1 over the frame (gradient text). */
function fullFrameImage(path: string, startSec: number, endSec: number, t: Target): ExportImage {
  return { path, boxW: t.width, boxH: t.height, x: 0, y: 0, startSec, endSec, opacity: 1 }
}

export interface ExportOptions {
  preset: PresetId
  preferNvenc: boolean
}

function sanitize(name: string): string {
  return name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'reel'
}

/** Suggested output filename for the Save dialog. */
export function suggestedExportName(projectName: string, preset: PresetId): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${sanitize(projectName)}_${preset}_${stamp}.mp4`
}

export async function exportProject(
  project: Project,
  opts: ExportOptions,
  outputPath: string
): Promise<string> {
  const job = createJob('export', `Export · ${project.name}`, project.id)
  try {
    await runExport(project, opts, job.id, outputPath)
    finishJob(job.id, outputPath)
    return outputPath
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * Everything a composition render needs that is NOT part of the composition
 * itself: the output target, the binaries, and the ROOT-level settings nested
 * clips still resolve against (a clip inside a comp inherits the project's
 * denoise/stabilize defaults, which only exist on the root document).
 */
interface RenderCtx {
  target: Target
  caps: FfmpegCapabilities
  ffmpeg: string
  jobId: string
  opts: ExportOptions
  denoiseDefault: boolean
  stabilizeDefault: Stabilize | null
  /** Root temp dir; each composition render gets a numbered subdir under it. */
  tmpRoot: string
  /** Pre-rendered comp intermediates, keyed by content hash — an identical comp
   *  (e.g. the same clip in two cells) is rendered once per export. */
  cache: Map<string, string>
  /** Monotonic counter for unique per-render temp subdirs. */
  n: { v: number }
}

async function runExport(
  project: Project,
  opts: ExportOptions,
  jobId: string,
  output: string
): Promise<string> {
  const target = targetForPreset(opts.preset)
  const caps = await getCapabilities()
  const { ffmpeg } = await getBinaries()
  const tmpRoot = join(getSubdir('tmp'), jobId)
  await fsp.mkdir(tmpRoot, { recursive: true })
  const ctx: RenderCtx = {
    target,
    caps,
    ffmpeg,
    jobId,
    opts,
    denoiseDefault: project.denoiseDefault,
    stabilizeDefault: project.stabilizeDefault,
    tmpRoot,
    cache: new Map(),
    n: { v: 0 }
  }
  const out = await renderComposition(project, ctx, output, { alpha: false, depth: 1 })
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  return out
}

/**
 * Render ONE composition to a file — the single implementation used for the
 * root project export AND (recursively, with `alpha`) for every nested comp
 * intermediate. Nested comps are pre-rendered to transparent VP9/WebM and fed
 * back in as ordinary video inputs (see FFMPEG-NOTES "Nested-composition
 * intermediates"), so the compositor itself never needs to know about nesting.
 */
async function renderComposition(
  comp: Composition,
  ctx: RenderCtx,
  output: string,
  o: { alpha: boolean; depth: number }
): Promise<string> {
  const { target, caps, ffmpeg, jobId, opts } = ctx
  // Canonical logical → output px. The project's format is a window centred on
  // the canonical 1080×1920 space (shared/frame.ts): positions shift by the
  // frame origin and every length scales by ONE uniform factor `s` (1 for every
  // built-in format — the output is the frame, px for px). Nested comps render
  // through the same frame, so an intermediate is frame-shaped too.
  const frame = presetFor(opts.preset).frame
  const m = frameToOutput(frame, target.width)
  const s = m.s

  const tmp = join(ctx.tmpRoot, `r${ctx.n.v++}`)
  await fsp.mkdir(tmp, { recursive: true })

  /**
   * Pre-render a nested composition to a transparent intermediate and hand back
   * an `ExportVideo` fragment the caller positions. Cached by comp content, so
   * the same comp used twice renders once. Returns null past the depth cap or
   * for an empty comp (nothing to composite).
   */
  const prerenderComp = async (
    nested: Composition
  ): Promise<{ path: string; len: number; hasAudio: boolean } | null> => {
    if (o.depth >= MAX_COMP_DEPTH) return null
    // Whole-source audio clips (`outSec <= 0`) end at their source duration,
    // which only the media store knows — resolve just those before measuring.
    const durs = new Map<string, number>()
    for (const a of nested.audioClips) {
      if (a.outSec <= 0 && !durs.has(a.mediaId)) {
        durs.set(a.mediaId, (await getAsset(a.mediaId))?.probe.durationSec ?? 0)
      }
    }
    const len = compositionDuration(nested, (id) => durs.get(id) ?? 0)
    if (len <= 0.01) return null
    const key = createHash('sha1')
      .update(JSON.stringify(nested))
      .update(`|${target.width}x${target.height}`)
      .digest('hex')
    let file = ctx.cache.get(key)
    if (!file) {
      file = join(ctx.tmpRoot, `comp_${key.slice(0, 12)}.webm`)
      await renderComposition(nested, ctx, file, { alpha: true, depth: o.depth + 1 })
      ctx.cache.set(key, file)
    }
    // The intermediate carries the comp's own audio (its clips + unmuted layer
    // audio, mixed by the nested render) whenever the comp had any.
    const hasAudio = nested.audioClips.length > 0 || nested.layers.some((l) => hasOwnAudio(l))
    return { path: file, len, hasAudio }
  }

  // A layer's position/scale keyframes, resolved for the compositor: display
  // box per keyframe (same stretchedBox math as the static path) in output px,
  // at absolute output times.
  const exportKeyframes = (l: Layer, aspect: number): ExportKeyframe[] =>
    (l.keyframes ?? []).map((k) => {
      const b = stretchedBox(aspect, k.scale, l.stretchX ?? 1, l.stretchY ?? 1)
      return {
        t: l.startSec + k.tSec,
        w: b.w * s,
        h: b.h * s,
        cx: m.x(k.x),
        cy: m.y(k.y)
      }
    })

  // Walk the stack back→front, resolving each visible layer to a composite step.
  // Geometry is mapped from the canonical logical space into output pixels.
  const visuals: ExportVisual[] = []
  const audio: ExportAudio[] = []
  let textN = 0
  // Gradient text/captions can't burn via libass — rasterise them to PNGs with
  // a reused off-screen renderer (created lazily; disposed before encoding).
  const fontsDir = getBundledFontsDir()
  const rendererRef: { current: TextRenderer | null } = { current: null }
  let gradN = 0
  function ensureRenderer(): TextRenderer {
    if (!rendererRef.current) {
      rendererRef.current = createTextRenderer(target.width, target.height, tmp, fontsDir)
    }
    return rendererRef.current
  }
  // Rasterise one text/caption spec (already scaled to output px) to a PNG and
  // wrap it as a full-frame overlay. Used for gradient fills and for text with an
  // explicit wrap width — cases libass can't render — matching the preview CSS.
  async function renderTextImage(
    spec: Parameters<TextRenderer['render']>[0],
    startSec: number,
    endSec: number
  ): Promise<ExportImage> {
    const pngPath = join(tmp, `grad_${gradN++}.png`)
    await ensureRenderer().render(spec, pngPath)
    return fullFrameImage(pngPath, startSec, endSec, target)
  }

  // Motion stabilization runs as a per-clip two-pass (vidstab) BEFORE compositing,
  // baking in the trim so the composite reads the stabilized intermediate from 0.
  // The HDR tonemap is folded into the transform pass (so the intermediate is
  // already SDR). Pre-pass ffmpegs don't drive the job progress bar — it stays at
  // 0 until the main encode; a long analysis is a silent wait (acceptable for v1).
  let stabN = 0
  async function stabilizeClip(
    srcPath: string,
    inSec: number,
    len: number,
    hdrChain: string,
    stab: Stabilize
  ): Promise<string> {
    const n = stabN++
    const job: StabilizeJob = {
      input: srcPath,
      inSec,
      len,
      shakiness: stab.shakiness,
      smoothing: stab.smoothing,
      hdrChain,
      trfFile: `stab_${n}.trf`,
      outFile: `stab_${n}.mp4`
    }
    await runFfmpeg(ffmpeg, buildVidstabDetectArgs(job), 0, undefined, tmp)
    await runFfmpeg(ffmpeg, buildVidstabTransformArgs(job), 0, undefined, tmp)
    return join(tmp, job.outFile)
  }
  // Keyframed OPACITY: a per-visual sendcmd file drives `colorchannelmixer aa`
  // per frame (verified — FFMPEG-NOTES "Keyframed opacity"). `base` folds an
  // image layer's static opacity into the animated values; a single point
  // needs no command file (the initial `aa=` covers a constant).
  let opN = 0
  async function opacityAnimFor(l: Layer, base = 1): Promise<OpacityAnim | undefined> {
    const pts = opacityKeyframePoints(l)
    if (!pts) return undefined
    const scaled = base !== 1 ? pts.map((p) => ({ t: p.t, o: p.o * base })) : pts
    const oid = `op${opN}`
    const lines = buildOpacityCmdLines(oid, scaled)
    let cmdFile: string | null = null
    if (lines) {
      cmdFile = `opacity_${opN}.cmd`
      await fsp.writeFile(join(tmp, cmdFile), lines, 'utf8')
    }
    opN++
    return { cmdFile, id: oid, initial: scaled[0].o }
  }
  for (const l of comp.layers) {
    if (l.hidden) continue
    const c = l.content
    if (c.kind === 'video') {
      const asset = await getAsset(c.mediaId)
      if (!asset) throw new Error(`Missing source media for a layer (${c.mediaId}).`)
      const v = asset.probe.video
      const aspect = c.crop ? c.crop.w / c.crop.h : v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : FRAME.width / FRAME.height
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
      const stab = effectiveStabilize(c, ctx.stabilizeDefault)
      if (stab) {
        srcPath = await stabilizeClip(asset.originalPath, c.inSec, trimLen, hdrChain, stab)
        srcInSec = 0
        hdrChain = ''
        // The stabilized intermediate is an opaque yuv420p mp4 — any alpha is gone.
        hasAlpha = false
        inputDecoder = null
      }
      visuals.push({
        kind: 'video',
        video: {
          path: srcPath,
          inSec: srcInSec,
          len: trimLen,
          hdrChain,
          hasAlpha,
          inputDecoder,
          crop: c.crop ?? null,
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
          ramp: hasSpeedRamp(c)
            ? (() => {
                const segs = speedSegments(c, c.inSec, c.outSec)
                return [
                  ...segs.map((s) => ({ u: s.s0 - c.inSec, v: s.v0 })),
                  { u: segs[segs.length - 1].s1 - c.inSec, v: segs[segs.length - 1].v1 }
                ]
              })()
            : undefined,
          keyframes: exportKeyframes(l, aspect),
          opacity: await opacityAnimFor(l)
        }
      })
      // An unmuted video layer's own audio joins the mix (placed at its start),
      // tempo-matched to the clip's speed (pitch-preserving atempo chain). A
      // RAMPED clip's audio is dropped — there is no variable-tempo audio path,
      // and the preview mutes it too so both sides agree.
      if (!c.mute && asset.probe.audio && !hasSpeedRamp(c)) {
        audio.push({
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
    } else if (c.kind === 'image') {
      const imgPath = imageAssetPath(c.mediaId)
      if (!existsSync(imgPath)) continue // display PNG missing → skip rather than fail
      const v = (await getAsset(c.mediaId))?.probe.video
      const base = v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 1
      // base aspect, reshaped by crop, swapped for 90°/270° rotation (shared helper).
      const aspect = effectiveImageAspect(base, c.crop, c.rotateQuarters)
      const q = (((c.rotateQuarters ?? 0) % 4) + 4) % 4
      const box = stretchedBox(aspect, l.scale, l.stretchX ?? 1, l.stretchY ?? 1)
      const boxW = box.w * s
      const boxH = box.h * s
      visuals.push({
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
          keyframes: exportKeyframes(l, aspect),
          opacityAnim: await opacityAnimFor(l, c.opacity)
        }
      })
    } else if (c.kind === 'layout') {
      // Each cell compiles to an ORDINARY compositor video entry (already-
      // verified crop→scale→overlay path): cover-cropped to its cell rect,
      // playing 1× from the layout's start, time-gated to the shorter of the
      // cell span and the layer window (audio clamps the same way so it can't
      // outlive the video). Cells composite in array order within the layer's
      // z-slot; empty cells let lower layers show through.
      const window = Math.max(0, l.endSec - l.startSec)
      for (const cell of c.cells) {
        // A cell carrying a composition renders that comp (pre-rendered to a
        // transparent intermediate) cover-cropped into the panel, exactly like
        // a single clip would be — the comp OVERRIDES mediaId.
        if (cell.comp) {
          const pre = await prerenderComp(cell.comp)
          if (!pre) continue
          const rect = layoutCellRect(l, cell.rect, frame)
          if (rect.w <= 0 || rect.h <= 0) continue
          const effSpan = Math.min(pre.len, window)
          if (effSpan <= 0.01) continue
          visuals.push({
            kind: 'video',
            video: {
              path: pre.path,
              inSec: 0,
              len: effSpan,
              hdrChain: '',
              hasAlpha: true,
              inputDecoder: 'libvpx-vp9',
              // The comp renders at the full output frame, so cover-crop it to
              // the cell the same way a source clip is cropped.
              crop: coverCrop(target.width, target.height, rect.w / rect.h),
              colorEq: '',
              boxW: rect.w * s,
              boxH: rect.h * s,
              x: r(m.x(rect.x)),
              y: r(m.y(rect.y)),
              startSec: l.startSec,
              endSec: l.startSec + effSpan,
              freezes: [],
              speed: 1
            }
          })
          if (!cell.mute && pre.hasAudio) {
            audio.push({
              path: pre.path,
              inSec: 0,
              outSec: effSpan,
              startSec: l.startSec,
              gainDb: 0,
              fadeInSec: 0,
              fadeOutSec: 0,
              duck: false,
              foldChannel: null
            })
          }
          continue
        }
        if (!cell.mediaId) continue
        const effSpan = Math.min(cellSpan(cell), window)
        if (effSpan <= 0.01) continue
        const asset = await getAsset(cell.mediaId)
        if (!asset?.probe.video) continue
        const v = asset.probe.video
        const rect = layoutCellRect(l, cell.rect, frame)
        if (rect.w <= 0 || rect.h <= 0) continue
        visuals.push({
          kind: 'video',
          video: {
            path: asset.originalPath,
            inSec: cell.inSec,
            len: effSpan,
            hdrChain: v.isHdr ? hdrToSdrChain(v) : '',
            hasAlpha: !!v.hasAlpha,
            inputDecoder: alphaInputDecoder(v),
            crop: coverCrop(v.displayWidth, v.displayHeight, rect.w / rect.h),
            colorEq: '',
            boxW: rect.w * s,
            boxH: rect.h * s,
            x: r(m.x(rect.x)),
            y: r(m.y(rect.y)),
            startSec: l.startSec,
            endSec: l.startSec + effSpan,
            freezes: [],
            speed: 1
          }
        })
        if (!cell.mute && asset.probe.audio) {
          audio.push({
            path: asset.originalPath,
            inSec: cell.inSec,
            outSec: cell.inSec + effSpan,
            startSec: l.startSec,
            gainDb: 0,
            fadeInSec: 0,
            fadeOutSec: 0,
            duck: false,
            foldChannel: asset.probe.audio.monoFoldChannel ?? null
          })
        }
      }
    } else if (c.kind === 'compound') {
      // A compound clip is its composition, pre-rendered to a transparent
      // intermediate and composited as an ordinary full-frame video input —
      // the same geometry rule as a layout (the layer transform moves/zooms
      // the whole comp frame), matching the preview's CompFill.
      const pre = await prerenderComp(c.comp)
      if (!pre) continue
      const rect = layoutCellRect(l, FULL_CELL, frame)
      if (rect.w <= 0 || rect.h <= 0) continue
      const window = Math.max(0, l.endSec - l.startSec)
      const effSpan = Math.min(pre.len, window)
      if (effSpan <= 0.01) continue
      visuals.push({
        kind: 'video',
        video: {
          path: pre.path,
          inSec: 0,
          len: effSpan,
          hdrChain: '',
          hasAlpha: true,
          // VP9 alpha is a side-band the native decoder drops — force libvpx.
          inputDecoder: 'libvpx-vp9',
          crop: null,
          colorEq: '',
          boxW: rect.w * s,
          boxH: rect.h * s,
          x: r(m.x(rect.x)),
          y: r(m.y(rect.y)),
          startSec: l.startSec,
          endSec: l.startSec + effSpan,
          freezes: [],
          speed: 1
        }
      })
      if (pre.hasAudio) {
        audio.push({
          path: pre.path,
          inSec: 0,
          outSec: effSpan,
          startSec: l.startSec,
          gainDb: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
          duck: false,
          foldChannel: null
        })
      }
    } else if (c.kind === 'text') {
      if (c.text.trim().length === 0) continue
      const fontSizePx = c.fontSizePx * l.scale * s
      // Decoration scale. The preview scales the WHOLE overlay
      // (`transform: scale(layer.scale)`), so a resized text layer grows its
      // pill padding, stroke and shadow along with the glyphs. Scaling those by
      // the output scale alone — as this once did — left a 1.43x-resized overlay
      // wearing a pill sized for the unscaled text. `l.scale` belongs in here
      // exactly as it already does in `fontSizePx` above.
      const decoScale = decorationScale(l.scale, s)
      // Sparkles are computed from the SAME shared helper the preview uses, at
      // the output-scaled font size — every offset it returns is a multiple of
      // that size, so the layout matches the preview at any preset. Positions
      // become absolute output px here; the ASS builder only formats them.
      const sparkleEffect = activeSparkle(c.effects)
      const textAnim = effectiveTextAnimation(c)
      const layerDur = Math.max(0.01, l.endSec - l.startSec)
      const sparkles: AssSparkle[] = sparkleEffect
        ? sparklesFor({
            effect: sparkleEffect,
            text: c.text,
            fontSizePx,
            durSec: layerDur,
            typewriterSec:
              textAnim?.in === 'typewriter' ? clampAnimWindows(textAnim, layerDur).inSec : 0
          }).map((sp) => ({
            startSec: l.startSec + sp.tSec,
            endSec: Math.min(l.endSec, l.startSec + sp.tSec + sp.lifeSec),
            x: r(m.x(l.x) + sp.x),
            y: r(m.y(l.y) + sp.y),
            sizePx: sp.sizePx,
            rotDeg: sp.rotDeg
          }))
        : []
      // A gradient (libass can't do it) OR an explicit wrap width (libass can't
      // wrap to an arbitrary width under \pos) burns as a full-frame PNG overlay,
      // rasterised with the same CSS the preview uses so the two match exactly.
      if (c.gradient || c.widthPx != null) {
        try {
          const image = await renderTextImage(
            {
              text: c.text,
              xCenter: m.x(l.x),
              yCenter: m.y(l.y),
              fontFamily: c.fontFamily,
              fontSizePx,
              color: c.color,
              gradient: c.gradient ?? undefined,
              widthPx: c.widthPx != null ? c.widthPx * l.scale * s : undefined,
              pill: scaledPill(c.pill, decoScale),
              stroke: scaledStroke(c.stroke, decoScale) ?? null,
              shadow: scaledShadow(c.shadow, decoScale) ?? null
            },
            l.startSec,
            l.endSec
          )
          visuals.push({ kind: 'image', image })
          // The glyphs are an image now, but the sparkles are still vector ASS
          // events — burn them on their own, above the picture, so a gradient
          // or wrapped overlay is not silently stripped of its effect.
          if (sparkles.length > 0) {
            const sparkleAss = `text_${textN++}.ass`
            await fsp.writeFile(
              join(tmp, sparkleAss),
              buildAss(
                [{ ...sparkleOnlyOverlay(c, l, m), sparkles, sparkleColor: sparkleEffect!.color }],
                target,
                null,
                s
              ),
              'utf8'
            )
            visuals.push({ kind: 'text', assFile: sparkleAss })
          }
          continue
        } catch {
          // Rasterising failed — fall through to a flat-colour ASS burn so the
          // overlay still appears (losing the gradient / exact wrap width).
        }
      }
      const assName = `text_${textN++}.ass`
      const overlay: AssOverlay = {
        text: c.text,
        startSec: l.startSec,
        endSec: l.endSec,
        x: r(m.x(l.x)),
        y: r(m.y(l.y)),
        anchor: 'center',
        fontFamily: c.fontFamily,
        fontSizePx,
        color: c.gradient ? c.gradient.from : c.color,
        // Same decoration scale as the raster path above: a resized layer's
        // pill/stroke/shadow grow with its glyphs, because that is what the
        // preview's `scale(layer.scale)` does to the whole overlay. The pill
        // was passed through completely unscaled here.
        pill: scaledPill(c.pill, decoScale),
        stroke: scaledStroke(c.stroke, decoScale),
        shadow: scaledShadow(c.shadow, decoScale),
        // Resolved (not raw): rasterised text (gradient/wrap fallback) never
        // animates, and the preview resolves through the same helper.
        animation: textAnim,
        sparkles,
        sparkleColor: sparkleEffect?.color
      }
      await fsp.writeFile(join(tmp, assName), buildAss([overlay], target, null, s), 'utf8')
      visuals.push({ kind: 'text', assFile: assName })
    }
  }

  if (!visuals.some((v) => v.kind !== 'text')) {
    throw new Error('Timeline has no video or image layer — add one first.')
  }

  // Audio clips (music / voiceover / extracted), trimmed + placed by the graph.
  for (const a of comp.audioClips) {
    // A muted clip is dropped before it ever becomes an input: `volume=0` would
    // work, but it would still decode the whole source to add silence to amix.
    if (!audioClipAudible(a)) continue
    const asset = await getAsset(a.mediaId)
    if (!asset) continue
    const proxy = join(getSubdir('media'), a.mediaId, 'audio.m4a')
    audio.push({
      path: existsSync(proxy) ? proxy : asset.originalPath,
      inSec: a.inSec,
      outSec: effectiveOut(a, asset.probe.durationSec),
      startSec: a.startSec,
      gainDb: a.gainDb,
      fadeInSec: a.fadeInSec,
      fadeOutSec: a.fadeOutSec,
      duck: a.duck,
      denoise: effectiveDenoise(a, ctx.denoiseDefault),
      foldChannel: asset.probe.audio?.monoFoldChannel ?? null
    })
  }

  // Captions (auto-generated) burn on top of everything. Scale each caption style
  // (lane-wide + any per-segment overrides) from logical into output px.
  let captionsAss: string | undefined
  const captionOverlays: ExportImage[] = []
  if (comp.captions.enabled && comp.captions.segments.some((s) => s.enabled)) {
    captionsAss = 'captions.ass'
    const scaleStyle = (st: CaptionStyle): CaptionStyle => ({
      ...st,
      x: m.x(st.x),
      y: m.y(st.y),
      fontSizePx: st.fontSizePx * s,
      pill: scaledPill(st.pill, s),
      stroke: scaledStroke(st.stroke, s),
      shadow: scaledShadow(st.shadow, s)
    })
    // Gradient-styled captions can't burn via libass — rasterise each to a PNG
    // composited ON TOP of the caption track. Track which rendered so the ASS
    // builder skips them (and a failed render falls back to a flat burn).
    const renderedGrad = new Set<string>()
    for (const seg of comp.captions.segments) {
      if (!seg.enabled || seg.text.trim().length === 0) continue
      const eff = seg.style ?? comp.captions.style
      if (!eff.gradient) continue
      const st = scaleStyle(eff)
      try {
        const image = await renderTextImage(
          {
            text: seg.text,
            xCenter: st.x,
            yCenter: st.y,
            fontFamily: st.fontFamily,
            fontSizePx: st.fontSizePx,
            color: st.color,
            gradient: st.gradient!,
            pill: st.pill,
            stroke: st.stroke ?? null,
            shadow: st.shadow ?? null,
            rotationDeg: st.rotationDeg
          },
          seg.startSec,
          seg.endSec
        )
        captionOverlays.push(image)
        renderedGrad.add(seg.id)
      } catch {
        // leave un-rendered → flat fallback below
      }
    }
    const scaled = {
      ...comp.captions,
      style: scaleStyle(comp.captions.style),
      segments: comp.captions.segments.map((s) => {
        if (!s.style) return s
        const sc = scaleStyle(s.style)
        // Keep gradient only if rasterised (buildAss skips gradient segments);
        // otherwise drop it so the caption still burns, flat.
        return { ...s, style: { ...sc, gradient: renderedGrad.has(s.id) ? sc.gradient : null } }
      })
    }
    await fsp.writeFile(join(tmp, captionsAss), buildAss([], target, scaled), 'utf8')
  }

  const visEnd = comp.layers.reduce((m, l) => (l.hidden ? m : Math.max(m, l.endSec)), 0)
  const audioEnd = audio.reduce((m, a) => Math.max(m, a.startSec + Math.max(0.01, a.outSec - a.inSec)), 0)
  const totalDur = Math.max(visEnd, audioEnd, 0.1)

  // The off-screen renderer has written all its PNGs to disk by now; free it
  // before the (long) encode.
  if (rendererRef.current) rendererRef.current.dispose()

  await fsp.mkdir(dirname(output), { recursive: true })
  const args = buildExportArgs(
    {
      target,
      totalDur,
      visuals,
      audio,
      captionsAss,
      topOverlays: captionOverlays,
      fontsDir: fontsDir ?? undefined,
      caps,
      preferNvenc: opts.preferNvenc,
      alpha: o.alpha
    },
    output
  )
  // Only the top-level render drives the job bar; nested pre-renders would
  // rewind it (weighting them across N+1 passes is a Stage 5 item).
  await runFfmpeg(ffmpeg, args, totalDur, o.depth === 1 ? (pr) => setProgress(jobId, pr) : undefined, tmp)

  return output
}

/** Whether a layer contributes its own audio to a composition's mix (used to
 *  decide if a pre-rendered intermediate has an audio stream to map). */
function hasOwnAudio(l: Layer): boolean {
  if (l.content.kind === 'video') return !l.content.mute
  if (l.content.kind === 'layout') return l.content.cells.some((cell) => !cell.mute && !!cell.mediaId)
  if (l.content.kind === 'compound') return true // resolved by its own render
  return false
}
