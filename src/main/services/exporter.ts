/**
 * Export orchestrator: normalize each clip → concat demuxer → single delivery
 * encode. Reports progress via the jobs channel (70% across the per-clip
 * normalize passes, 30% for the final encode). Exports from the ORIGINAL media,
 * not the proxy. Text overlays / captions are burned in a later milestone (M4).
 */

import { existsSync, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Layer, Project, TextContent, VideoContent } from '@shared/project'
import { effectiveOut } from '@shared/project'
import type { PresetId } from '@shared/export'
import { getSubdir } from '../config'
import { getBinaries, getCapabilities } from './ffmpeg'
import { getAsset, imageAssetPath } from './mediaStore'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import {
  buildFinalArgs,
  buildNormalizeArgs,
  targetForPreset,
  type ImageOverlayArg,
  type NormalizeClip
} from './exporterArgs'
import { buildAudioGraph, type AudioGraphItem } from './audio'
import { buildAss, type AssOverlay } from './assBuilder'
import { runFfmpeg } from './ffmpegRun'

const FRAME = { w: 1080, h: 1920 } as const

/** Logical-px display box of a media layer (aspect-fit, scaled, centered). */
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

const NORMALIZE_SHARE = 0.7

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
  // TODO(layers): this still concatenates the video layers as a sequence (sorted
  // by start time) and ignores per-layer position/zoom and simultaneous video
  // compositing. Full layer-compositing export is the next step; for now it
  // matches the previous single-track behaviour plus image/text overlays.
  const videoLayers = project.layers
    .filter((l): l is Layer & { content: VideoContent } => l.content.kind === 'video' && !l.hidden)
    .sort((a, b) => a.startSec - b.startSec)
  if (videoLayers.length === 0) throw new Error('Timeline has no video layer — add a clip first.')

  const target = targetForPreset(opts.preset)
  const caps = await getCapabilities()
  const { ffmpeg } = await getBinaries()

  const tmp = join(getSubdir('tmp'), jobId)
  await fsp.mkdir(tmp, { recursive: true })

  // Resolve video layers → source assets first, so the global duration is known
  // for accurate progress weighting across the normalize passes.
  const resolved = await Promise.all(
    videoLayers.map(async (layer) => {
      const c = layer.content
      const asset = await getAsset(c.mediaId)
      if (!asset) throw new Error(`Missing source media for a layer (${c.mediaId}).`)
      const clip: NormalizeClip = {
        inSec: c.inSec,
        outSec: c.outSec,
        crop: c.crop,
        mute: c.mute,
        gainDb: c.gainDb,
        color: c.color
      }
      return { clip, asset, durationSec: Math.max(0.01, c.outSec - c.inSec) }
    })
  )
  const totalDur = resolved.reduce((sum, r) => sum + r.durationSec, 0)

  const listLines: string[] = []
  let doneDur = 0
  for (let i = 0; i < resolved.length; i++) {
    const { clip, asset, durationSec } = resolved[i]
    const segPath = join(tmp, `seg_${i}.mov`)
    const args = buildNormalizeArgs(clip, asset, target, segPath)
    await runFfmpeg(ffmpeg, args, durationSec, (p) =>
      setProgress(jobId, ((doneDur + p * durationSec) / totalDur) * NORMALIZE_SHARE)
    )
    doneDur += durationSec
    listLines.push(`file '${segPath.replace(/\\/g, '/')}'`)
  }

  const listPath = join(tmp, 'concat.txt')
  await fsp.writeFile(listPath, listLines.join('\n'), 'utf8')

  // Burn text layers (if any) via an ASS pass in the final encode. The file is
  // referenced by relative name (ffmpeg cwd = tmp) to avoid filter-path escaping.
  let assFile: string | undefined
  const overlays: AssOverlay[] = project.layers
    .filter(
      (l): l is Layer & { content: TextContent } =>
        l.content.kind === 'text' && !l.hidden && l.content.text.trim().length > 0
    )
    .map((l) => ({
      text: l.content.text,
      startSec: l.startSec,
      endSec: l.endSec,
      x: l.x,
      y: l.y,
      anchor: 'center',
      fontSizePx: l.content.fontSizePx * l.scale,
      color: l.content.color,
      pill: l.content.pill
    }))
  const hasCaptions = project.captions.enabled && project.captions.segments.some((s) => s.enabled)
  if (overlays.length > 0 || hasCaptions) {
    assFile = 'overlays.ass'
    await fsp.writeFile(join(tmp, assFile), buildAss(overlays, target, project.captions), 'utf8')
  }

  // Audio track: each audio clip → an input + a node in the mix graph. The
  // concat's audio (0:a, the clip dialogue) is the base non-ducked source.
  const inputPaths: string[] = []
  const audioItems: AudioGraphItem[] = []
  for (const a of project.audioClips) {
    const asset = await getAsset(a.mediaId)
    if (!asset) continue
    const proxy = join(getSubdir('media'), a.mediaId, 'audio.m4a')
    const path = existsSync(proxy) ? proxy : asset.originalPath
    audioItems.push({
      inputLabel: `${1 + inputPaths.length}:a`,
      startSec: a.startSec,
      inSec: a.inSec,
      outSec: effectiveOut(a, asset.probe.durationSec),
      gainDb: a.gainDb,
      fadeInSec: a.fadeInSec,
      fadeOutSec: a.fadeOutSec,
      duck: a.duck,
      denoise: a.denoise
    })
    inputPaths.push(path)
  }
  const graph = audioItems.length > 0 ? buildAudioGraph(audioItems, '0:a') : null
  const audio = graph ? { inputPaths, filter: graph.filter, outLabel: graph.outLabel } : undefined

  // Image overlays → extra inputs composited via the overlay filter. Geometry is
  // in logical px (== target px for the 9:16 presets). Skip any whose display
  // PNG is missing (generation failed) so the encode still succeeds.
  const images: ImageOverlayArg[] = []
  for (const l of project.layers) {
    if (l.content.kind !== 'image' || l.hidden) continue
    const c = l.content
    const imgPath = imageAssetPath(c.mediaId)
    if (!existsSync(imgPath)) continue
    const v = (await getAsset(c.mediaId))?.probe.video
    const aspect = v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 1
    const box = layerBox(aspect, l.scale)
    images.push({
      path: imgPath,
      x: l.x,
      y: l.y,
      w: box.w,
      h: box.h,
      startSec: l.startSec,
      endSec: l.endSec,
      opacity: c.opacity,
      anchor: 'center'
    })
  }

  await fsp.mkdir(dirname(output), { recursive: true })
  const finalArgs = buildFinalArgs(listPath, output, caps, {
    preferNvenc: opts.preferNvenc,
    assFile,
    images: images.length ? images : undefined,
    audio
  })
  await runFfmpeg(
    ffmpeg,
    finalArgs,
    totalDur,
    (p) => setProgress(jobId, NORMALIZE_SHARE + p * (1 - NORMALIZE_SHARE)),
    tmp
  )

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  return output
}
