/**
 * Merge clips, main side: join windows of library videos (shared/merge.ts)
 * into ONE new file and adopt it into the library through `importGenerated`,
 * like Quick cut's pieces. Every segment is its own input (`-ss`/`-t` before
 * `-i`, frame-exact as in Quick cut), normalized to one size, frame rate and
 * pixel format, then joined with the concat filter. A clip without audio
 * contributes silence. Verified against ffmpeg 8.1.1 in docs/FFMPEG-NOTES.md
 * "Merge clips".
 *
 * buildMergeArgs is pure (unit-tested); mergeToLibrary runs ffmpeg.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { FfmpegEncoders } from '@shared/ffmpeg'
import { alphaInputDecoder, assetKind, type MediaAsset, type ProbeInfo, type VideoStreamInfo } from '@shared/media'
import { mergeDisplayName, mergePlan, mergeProblem, mergeWords, type MergePlan, type MergeSegment } from '@shared/merge'
import type { Transcript } from '@shared/transcript'
import { monoFoldPan } from './audio'
import { f3 } from './ffmpegFilters'
import { replaceFile, writeAtomically } from './atomicWrite'
import { getBinaries, getCapabilities } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import { ensureProxy, importGenerated, requireUsable, tmpOutput, transcriptFile } from './mediaStore'
import { hdrToSdrChain } from './proxy'
import { isTenBit, videoArgs } from './quickCut'
import { getTranscript } from './whisper'

/** One segment with the file and probe it reads from. */
export interface MergeInput {
  path: string
  probe: ProbeInfo
  segment: MergeSegment
}

/** The stream the merge encodes to: what `videoArgs` keeps the character of. */
export function mergeOutputVideo(plan: MergePlan, first: VideoStreamInfo): VideoStreamInfo {
  if (plan.mode === 'alpha') return { ...first, hasAlpha: true }
  if (plan.mode === 'hdr' || !plan.toneMap.some(Boolean)) return { ...first, hasAlpha: false }
  // HDR and SDR mixed: everything is tone-mapped to 8-bit bt709 H.264.
  return {
    ...first,
    codec: 'h264',
    pixFmt: 'yuv420p',
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorSpace: 'bt709',
    isHdr: false,
    hasAlpha: false
  }
}

export const mergeExt = (plan: MergePlan): 'webm' | 'mp4' => (plan.mode === 'alpha' ? 'webm' : 'mp4')

/** Window length from the ROUNDED start, so the segment still ends at outSec (as Quick cut). */
const segLen = (s: MergeSegment): string => f3(s.outSec - Number(f3(s.inSec)))

export function buildMergeArgs(inputs: MergeInput[], output: string, enc: FfmpegEncoders): string[] {
  if (inputs.some((i) => !i.probe.video)) throw new Error('Merge clips needs video clips.')
  const plan = mergePlan(inputs.map((i) => i.probe.video!))
  const out = mergeOutputVideo(plan, inputs[0].probe.video!)
  const alpha = plan.mode === 'alpha'
  const pixFmt = alpha ? 'yuva420p' : isTenBit(out) ? 'yuv420p10le' : 'yuv420p'
  const { width: W, height: H } = plan
  const hasAudio = inputs.some((i) => i.probe.audio)

  const inArgs: string[] = []
  const graph: string[] = []
  const pairs: string[] = []
  for (const [i, { path, probe, segment }] of inputs.entries()) {
    const dec = alphaInputDecoder(probe.video!)
    const len = segLen(segment)
    inArgs.push(...(dec ? ['-c:v', dec] : []), '-ss', f3(segment.inSec), '-t', len, '-i', path)
    const video = [
      ...(plan.toneMap[i] ? [hdrToSdrChain(probe.video!)] : []),
      ...(alpha ? ['format=yuva420p'] : []),
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2${alpha ? ':color=black@0' : ''}`,
      'setsar=1',
      `fps=${plan.fps}`,
      `format=${pixFmt}`,
      'setpts=PTS-STARTPTS',
      `trim=duration=${len}`
    ]
    graph.push(`[${i}:v:0]${video.join(',')}[v${i}]`)
    pairs.push(`[v${i}]`)
    if (!hasAudio) continue
    const a = probe.audio
    const audio = a
      ? `[${i}:a:0]${[
          ...(a.monoFoldChannel != null ? [monoFoldPan(a.monoFoldChannel)] : []),
          'aresample=48000',
          'aformat=sample_fmts=fltp:channel_layouts=stereo',
          'apad',
          'asetpts=PTS-STARTPTS',
          `atrim=duration=${len}`
        ].join(',')}`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${len}`
    graph.push(`${audio}[a${i}]`)
    pairs.push(`[a${i}]`)
  }
  graph.push(`${pairs.join('')}concat=n=${inputs.length}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? '[v][a]' : '[v]'}`)

  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...inArgs,
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[v]',
    ...(hasAudio ? ['-map', '[a]'] : []),
    '-map_metadata',
    '0',
    ...videoArgs(out, enc),
    ...(hasAudio ? (alpha ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '256k']) : ['-an']),
    ...(alpha ? [] : ['-movflags', '+faststart']),
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ]
}

/**
 * Merge library video windows, in order, into ONE new library clip. The
 * sources stay as they are. Throws (before any encode) when the merge is
 * invalid or a clip unusable; a failed encode leaves nothing behind.
 */
export async function mergeToLibrary(segments: MergeSegment[]): Promise<MediaAsset> {
  const ids = [...new Set(segments.map((s) => s.mediaId))]
  const assets = new Map<string, MediaAsset>()
  for (const id of ids) {
    const a = await requireUsable(id)
    if (assetKind(a) !== 'video' || !a.probe.video) throw new Error(`${a.fileName} is not a video clip.`)
    assets.set(id, a)
  }
  const problem = mergeProblem(segments, (id) => assets.get(id)!.probe.durationSec)
  if (problem) throw new Error(problem)

  const inputs: MergeInput[] = segments.map((segment) => {
    const a = assets.get(segment.mediaId)!
    return { path: a.originalPath, probe: a.probe, segment }
  })
  const plan = mergePlan(inputs.map((i) => i.probe.video!))
  const ext = mergeExt(plan)
  const first = assets.get(segments[0].mediaId)!
  const name = mergeDisplayName([first.fileName], ids.length === 1, ext)

  // Transcripts: carried only when every clip with audio has one.
  const transcripts = new Map<string, Transcript | null>()
  for (const id of ids) transcripts.set(id, assets.get(id)!.probe.audio ? await getTranscript(id) : null)
  const words = mergeWords(segments, (s) =>
    assets.get(s.mediaId)!.probe.audio ? (transcripts.get(s.mediaId)?.words ?? null) : []
  )
  const firstTranscript = [...transcripts.values()].find((t) => t)

  const [{ ffmpeg }, caps] = await Promise.all([getBinaries(), getCapabilities()])
  const total = segments.reduce((s, p) => s + p.outSec - p.inSec, 0)
  const job = createJob('proxy', `Merge clips · ${name}`, undefined, { uses: ids })
  let asset: MediaAsset
  try {
    const tmp = tmpOutput('merge', ext)
    await writeAtomically(tmp, (part) =>
      runFfmpeg(ffmpeg, buildMergeArgs(inputs, part, caps.encoders), total, (p) => setProgress(job.id, p))
    )
    asset = await importGenerated(tmp, name)
    if (words && firstTranscript) {
      const { model, createdAt, timing, version } = firstTranscript
      const t: Transcript = { mediaId: asset.id, words, model, createdAt, timing, version }
      const path = transcriptFile(asset.id)
      await fsp.mkdir(join(path, '..'), { recursive: true })
      await replaceFile(path, JSON.stringify(t, null, 2))
    }
    finishJob(job.id)
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
  if (!asset.proxyReady) void ensureProxy(asset.id).catch((err) => console.error('merge proxy failed', asset.id, err))
  return asset
}
