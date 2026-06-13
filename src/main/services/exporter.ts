/**
 * Export orchestrator: normalize each clip → concat demuxer → single delivery
 * encode. Reports progress via the jobs channel (70% across the per-clip
 * normalize passes, 30% for the final encode). Exports from the ORIGINAL media,
 * not the proxy. Text overlays / captions are burned in a later milestone (M4).
 */

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Project } from '@shared/project'
import type { PresetId } from '@shared/export'
import { getSubdir } from '../config'
import { getBinaries, getCapabilities } from './ffmpeg'
import { getAsset } from './mediaStore'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import { buildFinalArgs, buildNormalizeArgs, targetForPreset } from './exporterArgs'
import { runFfmpeg } from './ffmpegRun'

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
  if (project.clips.length === 0) throw new Error('Timeline is empty — add a clip first.')

  const target = targetForPreset(opts.preset)
  const caps = await getCapabilities()
  const { ffmpeg } = await getBinaries()

  const tmp = join(getSubdir('tmp'), jobId)
  await fsp.mkdir(tmp, { recursive: true })

  // Resolve clips → source assets first, so the global duration is known for
  // accurate progress weighting across the normalize passes.
  const resolved = await Promise.all(
    project.clips.map(async (clip) => {
      const asset = await getAsset(clip.mediaId)
      if (!asset) throw new Error(`Missing source media for a clip (${clip.mediaId}).`)
      return { clip, asset, durationSec: Math.max(0.01, clip.outSec - clip.inSec) }
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

  await fsp.mkdir(dirname(output), { recursive: true })
  const finalArgs = buildFinalArgs(listPath, output, caps, { preferNvenc: opts.preferNvenc })
  await runFfmpeg(ffmpeg, finalArgs, totalDur, (p) => setProgress(jobId, NORMALIZE_SHARE + p * (1 - NORMALIZE_SHARE)))

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  return output
}
