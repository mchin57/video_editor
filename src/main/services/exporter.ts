/**
 * Export orchestrator: composites the unified layer stack in a SINGLE ffmpeg
 * pass (black base canvas → overlay each visual layer in z-order → mix audio →
 * encode). Several video layers play at once, each scaled/positioned to its
 * layer transform and time-gated to its window; text layers burn via per-layer
 * ASS so the full back-to-front order is honored. Exports from the ORIGINAL
 * media. Progress is the single encode's progress over the project duration.
 *
 * This module is the entry points (an export job, a stills render); one
 * composition render is `CompositionRender` (exportRender.ts), with one
 * exporter per layer kind (exportLayers.ts, exportText.ts).
 */

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Composition, Project } from '@shared/project'
import { referencedMediaIds } from '@shared/project'
import type { ExportOptions } from '@shared/ipc'
import type { PresetId } from '@shared/formats'
import { newId } from '@shared/ids'
import { getSubdir } from '../config'
import { getBinaries, getCapabilities } from './ffmpeg'
import { assertMediaUsable } from './mediaStore'
import { createJob, failJob, finishJob } from './jobs'
import { targetForPreset } from './exporterArgs'
import { assertWritableDir, writeAtomically } from './atomicWrite'
import { renderComposition, type FrameRequest, type RenderCtx } from './exportRender'
import { createLogger, bestEffort } from '@shared/log'

const log = createLogger('export')

function sanitize(name: string): string {
  return (
    name
      .replace(/[^\w-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'reel'
  )
}

/** Suggested output filename for the Save dialog. */
export function suggestedExportName(projectName: string, preset: PresetId): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${sanitize(projectName)}_${preset}_${stamp}.mp4`
}

/** What a canceled export rejects with (the job itself reads `canceled`). */
export const EXPORT_CANCELED = 'Export canceled'

export async function exportProject(project: Project, opts: ExportOptions, outputPath: string): Promise<string> {
  const mediaIds = referencedMediaIds(project)
  const job = createJob('export', `Export · ${project.name}`, project.id, { uses: mediaIds, cancelable: true })
  try {
    // Missing or changed originals block the export, naming every file — never
    // render a clip from different bytes than the user edited.
    await assertMediaUsable(mediaIds)
    await assertWritableDir(dirname(outputPath))
    // Encode to `<name>.part.mp4` and rename on success: a failed or killed run
    // never leaves a torn file at the chosen name, nor replaces one already there.
    await writeAtomically(outputPath, async (part) => {
      await runExport(project, opts, job.id, part, job.signal)
    })
    finishJob(job.id, outputPath)
    return outputPath
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    // Canceled: the throw is the run unwinding (ffmpeg killed, partial file
    // removed by writeAtomically), so say that rather than ffmpeg's exit code.
    if (job.signal?.aborted) throw new Error(EXPORT_CANCELED)
    throw error
  }
}

/** The render context shared by every composition of one export or stills
 *  render (the caller creates and removes `tmpRoot`). */
async function renderCtx(
  project: Project,
  opts: ExportOptions,
  jobId: string,
  tmpRoot: string,
  extra: Pick<RenderCtx, 'signal' | 'stills'> = {}
): Promise<RenderCtx> {
  return {
    target: targetForPreset(opts.preset),
    caps: await getCapabilities(),
    ffmpeg: (await getBinaries()).ffmpeg,
    jobId,
    opts,
    denoiseDefault: project.denoiseDefault,
    stabilizeDefault: project.stabilizeDefault,
    volumeLevels: project.volumeLevels ?? [],
    tmpRoot,
    cache: new Map(),
    n: { v: 0 },
    ...extra
  }
}

async function runExport(
  project: Project,
  opts: ExportOptions,
  jobId: string,
  output: string,
  signal?: AbortSignal
): Promise<string> {
  const tmpRoot = join(getSubdir('tmp'), jobId)
  const ctx = await renderCtx(project, opts, jobId, tmpRoot, { signal })
  await fsp.mkdir(tmpRoot, { recursive: true })
  try {
    return await renderComposition(project, ctx, output, { alpha: false, depth: 1 })
  } finally {
    await bestEffort(fsp.rm(tmpRoot, { recursive: true, force: true }), 'removing the render scratch folder', log)
  }
}

/**
 * The finished frame at each timeline second in `times` (1–4), as JPEGs in
 * `outDir` — the export's own compositor, text layout and caption burn, cut to
 * single frames (`buildFrameArgs`). `comp` is what to render (default: the
 * whole project; pass the composition being edited when the user is inside a
 * compound clip, so its local times line up). Not an export job: it never
 * blocks the Export button and shows no progress. Skips the stabilization
 * pre-pass (a whole-clip analysis per frame would be far too slow);
 * `skippedStabilize` says when that made a frame differ from the real export.
 */
export async function renderFrames(
  project: Project,
  preset: PresetId,
  times: number[],
  outDir: string,
  comp: Composition = project
): Promise<{ frames: { path: string; shownSec: number }[]; skippedStabilize: boolean }> {
  await assertMediaUsable(referencedMediaIds(comp))
  const tmpRoot = join(getSubdir('tmp'), `frames-${newId()}`)
  const stills = { skippedStabilize: false }
  const ctx = await renderCtx(project, { preset, preferNvenc: false }, '', tmpRoot, { stills })
  await fsp.mkdir(tmpRoot, { recursive: true })
  const frames: FrameRequest[] = times.map((timeSec, k) => ({ timeSec, path: join(outDir, `frame_${k}.jpg`) }))
  try {
    await renderComposition(comp, ctx, frames[0].path, { alpha: false, depth: 1, frames })
  } finally {
    await bestEffort(fsp.rm(tmpRoot, { recursive: true, force: true }), 'removing the render scratch folder', log)
  }
  return {
    frames: frames.map((f) => ({ path: f.path, shownSec: f.shownSec ?? f.timeSec })),
    skippedStabilize: stills.skippedStabilize
  }
}
