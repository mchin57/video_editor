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
import type { CaptionStyle, Project } from '@shared/project'
import { effectiveOut, isNeutralColor } from '@shared/project'
import type { PresetId } from '@shared/export'
import { getSubdir } from '../config'
import { getBinaries, getCapabilities } from './ffmpeg'
import { getAsset, imageAssetPath } from './mediaStore'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import { buildExportArgs, targetForPreset, type ExportAudio, type ExportVisual } from './exporterArgs'
import { buildAss, type AssOverlay } from './assBuilder'
import { hdrToSdrChain } from './proxy'
import { runFfmpeg } from './ffmpegRun'

const FRAME = { w: 1080, h: 1920 } as const

/** Logical-px display box of a media layer (aspect-fit within the frame, scaled). */
function layerBox(aspect: number, scale: number): { w: number; h: number } {
  const fa = FRAME.w / FRAME.h
  let w: number
  let h: number
  if (aspect >= fa) {
    w = FRAME.w
    h = FRAME.w / aspect
  } else {
    h = FRAME.h
    w = FRAME.h * aspect
  }
  return { w: w * scale, h: h * scale }
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
  const sx = target.width / FRAME.w
  const sy = target.height / FRAME.h
  const r = (n: number): number => Math.round(n)

  const tmp = join(getSubdir('tmp'), jobId)
  await fsp.mkdir(tmp, { recursive: true })

  // Walk the stack back→front, resolving each visible layer to a composite step.
  // Geometry is mapped from the logical 1080x1920 space into output pixels.
  const visuals: ExportVisual[] = []
  const audio: ExportAudio[] = []
  let textN = 0
  for (const l of project.layers) {
    if (l.hidden) continue
    const c = l.content
    if (c.kind === 'video') {
      const asset = await getAsset(c.mediaId)
      if (!asset) throw new Error(`Missing source media for a layer (${c.mediaId}).`)
      const v = asset.probe.video
      const aspect = c.crop ? c.crop.w / c.crop.h : v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : FRAME.w / FRAME.h
      const box = layerBox(aspect, l.scale)
      const boxW = box.w * sx
      const boxH = box.h * sy
      visuals.push({
        kind: 'video',
        video: {
          path: asset.originalPath,
          inSec: c.inSec,
          len: Math.max(0.01, c.outSec - c.inSec),
          hdrChain: v?.isHdr ? hdrToSdrChain(v) : '',
          crop: c.crop ?? null,
          colorEq: isNeutralColor(c.color)
            ? ''
            : `eq=brightness=${c.color!.brightness}:contrast=${c.color!.contrast}:saturation=${c.color!.saturation}`,
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
      let aspect = v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 1
      if (c.crop && c.crop.h > 0) aspect *= c.crop.w / c.crop.h // crop reshapes the box
      const q = (((c.rotateQuarters ?? 0) % 4) + 4) % 4
      if (q === 1 || q === 3) aspect = 1 / aspect // 90°/270° swap width and height
      const box = layerBox(aspect, l.scale)
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
      const assName = `text_${textN++}.ass`
      const overlay: AssOverlay = {
        text: c.text,
        startSec: l.startSec,
        endSec: l.endSec,
        x: r(l.x * sx),
        y: r(l.y * sy),
        anchor: 'center',
        fontSizePx: c.fontSizePx * l.scale * sy,
        color: c.color,
        pill: c.pill
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
      denoise: a.denoise
    })
  }

  // Captions (auto-generated) burn on top of everything. Scale each caption style
  // (lane-wide + any per-segment overrides) from logical into output px.
  let captionsAss: string | undefined
  if (project.captions.enabled && project.captions.segments.some((s) => s.enabled)) {
    captionsAss = 'captions.ass'
    const scaleStyle = (st: CaptionStyle): CaptionStyle => ({
      ...st,
      x: st.x * sx,
      y: st.y * sy,
      fontSizePx: st.fontSizePx * sy,
      pill: { ...st.pill, padPx: st.pill.padPx * sy }
    })
    const scaled = {
      ...project.captions,
      style: scaleStyle(project.captions.style),
      segments: project.captions.segments.map((s) => (s.style ? { ...s, style: scaleStyle(s.style) } : s))
    }
    await fsp.writeFile(join(tmp, captionsAss), buildAss([], target, scaled), 'utf8')
  }

  const visEnd = project.layers.reduce((m, l) => (l.hidden ? m : Math.max(m, l.endSec)), 0)
  const audioEnd = audio.reduce((m, a) => Math.max(m, a.startSec + Math.max(0.01, a.outSec - a.inSec)), 0)
  const totalDur = Math.max(visEnd, audioEnd, 0.1)

  await fsp.mkdir(dirname(output), { recursive: true })
  const args = buildExportArgs(
    { target, totalDur, visuals, audio, captionsAss, caps, preferNvenc: opts.preferNvenc },
    output
  )
  await runFfmpeg(ffmpeg, args, totalDur, (p) => setProgress(jobId, p), tmp)

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  return output
}
