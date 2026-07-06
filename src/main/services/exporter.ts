/**
 * Export orchestrator: composites the unified layer stack in a SINGLE ffmpeg
 * pass (black base canvas → overlay each visual layer in z-order → mix audio →
 * encode). Several video layers play at once, each scaled/positioned to its
 * layer transform and time-gated to its window; text layers burn via per-layer
 * ASS so the full back-to-front order is honored. Exports from the ORIGINAL
 * media. Progress is the single encode's progress over the project duration.
 */

import { existsSync, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CaptionStyle, PillStyle, Project, ShadowStyle, StrokeStyle, Stabilize } from '@shared/project'
import { effectiveDenoise, effectiveOut, effectiveStabilize, isNeutralColor } from '@shared/project'
import type { PresetId } from '@shared/export'
import { alphaInputDecoder } from '@shared/media'
import { effectiveImageAspect, FRAME, stretchedBox } from '@shared/layers'
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
import { buildAss, type AssOverlay } from './assBuilder'
import { createTextRenderer, type TextRenderer } from './textImage'
import { hdrToSdrChain } from './proxy'
import { runFfmpeg } from './ffmpegRun'
import { eqFilter, r } from './ffmpegFilters'

/** Scale optional decorations from logical to output px (matching font scaling). */
const scaledStroke = (s: StrokeStyle | null | undefined, k: number): StrokeStyle | null | undefined =>
  s ? { widthPx: s.widthPx * k, color: s.color } : s
const scaledShadow = (s: ShadowStyle | null | undefined, k: number): ShadowStyle | null | undefined =>
  s ? { distancePx: s.distancePx * k, color: s.color, blur: s.blur * k } : s
const scaledPill = (p: PillStyle, k: number): PillStyle => ({ ...p, padPx: p.padPx * k })

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

async function runExport(
  project: Project,
  opts: ExportOptions,
  jobId: string,
  output: string
): Promise<string> {
  const target = targetForPreset(opts.preset)
  const caps = await getCapabilities()
  const { ffmpeg } = await getBinaries()
  const sx = target.width / FRAME.width
  const sy = target.height / FRAME.height

  const tmp = join(getSubdir('tmp'), jobId)
  await fsp.mkdir(tmp, { recursive: true })

  // Walk the stack back→front, resolving each visible layer to a composite step.
  // Geometry is mapped from the logical 1080x1920 space into output pixels.
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
  for (const l of project.layers) {
    if (l.hidden) continue
    const c = l.content
    if (c.kind === 'video') {
      const asset = await getAsset(c.mediaId)
      if (!asset) throw new Error(`Missing source media for a layer (${c.mediaId}).`)
      const v = asset.probe.video
      const aspect = c.crop ? c.crop.w / c.crop.h : v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : FRAME.width / FRAME.height
      const box = stretchedBox(aspect, l.scale, l.stretchX ?? 1, l.stretchY ?? 1)
      const boxW = box.w * sx
      const boxH = box.h * sy
      const trimLen = Math.max(0.01, c.outSec - c.inSec)
      // Stabilization (clip override, else project default) pre-renders a
      // trimmed, SDR, stabilized intermediate; the composite then reads it from
      // 0 with the tonemap already applied.
      let srcPath = asset.originalPath
      let srcInSec = c.inSec
      let hdrChain = v?.isHdr ? hdrToSdrChain(v) : ''
      let hasAlpha = !!v?.hasAlpha
      let inputDecoder = alphaInputDecoder(v)
      const stab = effectiveStabilize(c, project.stabilizeDefault)
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
          x: r(l.x * sx - boxW / 2),
          y: r(l.y * sy - boxH / 2),
          startSec: l.startSec,
          endSec: l.endSec,
          freezes: (c.freezes ?? []).map((f) => ({ atLocal: f.atSec - c.inSec, holdSec: f.holdSec }))
        }
      })
      // An unmuted video layer's own audio joins the mix (placed at its start).
      if (!c.mute && asset.probe.audio) {
        audio.push({
          path: asset.originalPath,
          inSec: c.inSec,
          outSec: c.outSec,
          startSec: l.startSec,
          gainDb: c.gainDb,
          fadeInSec: 0,
          fadeOutSec: 0,
          duck: false
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
      const boxW = box.w * sx
      const boxH = box.h * sy
      visuals.push({
        kind: 'image',
        image: {
          path: imgPath,
          boxW,
          boxH,
          x: r(l.x * sx - boxW / 2),
          y: r(l.y * sy - boxH / 2),
          startSec: l.startSec,
          endSec: l.endSec,
          opacity: c.opacity,
          crop: c.crop ?? null,
          rotateQuarters: q,
          flipH: c.flipH,
          flipV: c.flipV
        }
      })
    } else {
      if (c.text.trim().length === 0) continue
      const fontSizePx = c.fontSizePx * l.scale * sy
      // A gradient (libass can't do it) OR an explicit wrap width (libass can't
      // wrap to an arbitrary width under \pos) burns as a full-frame PNG overlay,
      // rasterised with the same CSS the preview uses so the two match exactly.
      if (c.gradient || c.widthPx != null) {
        try {
          const image = await renderTextImage(
            {
              text: c.text,
              xCenter: l.x * sx,
              yCenter: l.y * sy,
              fontFamily: c.fontFamily,
              fontSizePx,
              color: c.color,
              gradient: c.gradient ?? undefined,
              widthPx: c.widthPx != null ? c.widthPx * l.scale * sx : undefined,
              pill: scaledPill(c.pill, sy),
              stroke: scaledStroke(c.stroke, sy) ?? null,
              shadow: scaledShadow(c.shadow, sy) ?? null
            },
            l.startSec,
            l.endSec
          )
          visuals.push({ kind: 'image', image })
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
        x: r(l.x * sx),
        y: r(l.y * sy),
        anchor: 'center',
        fontFamily: c.fontFamily,
        fontSizePx,
        color: c.gradient ? c.gradient.from : c.color,
        pill: c.pill,
        stroke: scaledStroke(c.stroke, sy),
        shadow: scaledShadow(c.shadow, sy)
      }
      await fsp.writeFile(join(tmp, assName), buildAss([overlay], target), 'utf8')
      visuals.push({ kind: 'text', assFile: assName })
    }
  }

  if (!visuals.some((v) => v.kind !== 'text')) {
    throw new Error('Timeline has no video or image layer — add one first.')
  }

  // Audio clips (music / voiceover / extracted), trimmed + placed by the graph.
  for (const a of project.audioClips) {
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
      denoise: effectiveDenoise(a, project.denoiseDefault)
    })
  }

  // Captions (auto-generated) burn on top of everything. Scale each caption style
  // (lane-wide + any per-segment overrides) from logical into output px.
  let captionsAss: string | undefined
  const captionOverlays: ExportImage[] = []
  if (project.captions.enabled && project.captions.segments.some((s) => s.enabled)) {
    captionsAss = 'captions.ass'
    const scaleStyle = (st: CaptionStyle): CaptionStyle => ({
      ...st,
      x: st.x * sx,
      y: st.y * sy,
      fontSizePx: st.fontSizePx * sy,
      pill: scaledPill(st.pill, sy),
      stroke: scaledStroke(st.stroke, sy),
      shadow: scaledShadow(st.shadow, sy)
    })
    // Gradient-styled captions can't burn via libass — rasterise each to a PNG
    // composited ON TOP of the caption track. Track which rendered so the ASS
    // builder skips them (and a failed render falls back to a flat burn).
    const renderedGrad = new Set<string>()
    for (const seg of project.captions.segments) {
      if (!seg.enabled || seg.text.trim().length === 0) continue
      const eff = seg.style ?? project.captions.style
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
      ...project.captions,
      style: scaleStyle(project.captions.style),
      segments: project.captions.segments.map((s) => {
        if (!s.style) return s
        const sc = scaleStyle(s.style)
        // Keep gradient only if rasterised (buildAss skips gradient segments);
        // otherwise drop it so the caption still burns, flat.
        return { ...s, style: { ...sc, gradient: renderedGrad.has(s.id) ? sc.gradient : null } }
      })
    }
    await fsp.writeFile(join(tmp, captionsAss), buildAss([], target, scaled), 'utf8')
  }

  const visEnd = project.layers.reduce((m, l) => (l.hidden ? m : Math.max(m, l.endSec)), 0)
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
      preferNvenc: opts.preferNvenc
    },
    output
  )
  await runFfmpeg(ffmpeg, args, totalDur, (p) => setProgress(jobId, p), tmp)

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  return output
}
