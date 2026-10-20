/**
 * Quick cut, main side: re-encode each piece of a cut (shared/quickCut.ts) to
 * its own file and adopt it into the library through `importGenerated`, so it
 * lands in the project's `generated/` like every other file the editor makes.
 *
 * Frame-accurate rather than stream-copied: a copy can only start on a
 * keyframe (about 1 s apart on iPhone footage). The encode keeps the source's
 * character — HEVC / 10-bit stays HEVC Main10 with its HDR tags, H.264 stays
 * H.264, a background-removed WebM keeps its alpha — and bakes the rotation
 * flag into the pixels. Verified against ffmpeg 8.1.1 in docs/FFMPEG-NOTES.md
 * "Quick cut".
 *
 * buildCutArgs is pure (unit-tested); cutToLibrary runs ffmpeg.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { FfmpegEncoders } from '@shared/ffmpeg'
import { alphaInputDecoder, assetKind, type MediaAsset, type ProbeInfo, type VideoStreamInfo } from '@shared/media'
import { cutDisplayNames, cutProblem, sliceWords, type CutPiece } from '@shared/quickCut'
import type { Transcript } from '@shared/transcript'
import { f3 } from './ffmpegFilters'
import { replaceFile, writeAtomically } from './atomicWrite'
import { getBinaries, getCapabilities } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'
import { createJob, failJob, finishJob, setProgress } from './jobs'
import { ensureProxy, importGenerated, requireUsable, tmpOutput, transcriptFile } from './mediaStore'
import { getTranscript } from './whisper'
import { requireSession, type ProjectSession } from './projectSession'
import { createLogger } from '@shared/log'

const log = createLogger('quick-cut')

/** A cut keeps quality close to the source: it is a new original, not a proxy. */
const CQ = '18'

/** Color tags ffmpeg accepts back as option values (ffprobe's "unknown" etc. are not). */
const colorTag = (v: string | null): v is string => !!v && !/^(unknown|unspecified|reserved)$/i.test(v)

/** The output container for a cut of this source: WebM keeps an alpha clip's
 *  transparency (VP9 `yuva420p`); everything else is an MP4. */
export function cutExt(probe: ProbeInfo): 'webm' | 'mp4' {
  return probe.video?.hasAlpha ? 'webm' : 'mp4'
}

/** A 10- or 12-bit source (HDR iPhone footage). */
export const isTenBit = (v: Pick<VideoStreamInfo, 'pixFmt'>): boolean => /1[02]/.test(v.pixFmt) || /p010/.test(v.pixFmt)

/** Encoder args that keep a source's character: shared by Quick cut and
 *  Merge clips (`services/merge.ts`). */
export function videoArgs(v: VideoStreamInfo, enc: FfmpegEncoders): string[] {
  if (v.hasAlpha) return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '20', '-row-mt', '1']
  const tenBit = isTenBit(v)
  const hevc = tenBit || v.codec === 'hevc'
  const color = [
    ...(colorTag(v.colorPrimaries) ? ['-color_primaries', v.colorPrimaries] : []),
    ...(colorTag(v.colorTransfer) ? ['-color_trc', v.colorTransfer] : []),
    ...(colorTag(v.colorSpace) ? ['-colorspace', v.colorSpace] : [])
  ]
  if (hevc && enc.hevc_nvenc) {
    const depth = tenBit ? ['-profile:v', 'main10', '-pix_fmt', 'p010le'] : ['-pix_fmt', 'yuv420p']
    return [
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p6',
      '-tune',
      'hq',
      '-rc',
      'vbr',
      '-cq',
      CQ,
      '-b:v',
      '0',
      ...depth,
      ...color,
      '-tag:v',
      'hvc1'
    ]
  }
  if (hevc && enc.libx265) {
    const depth = ['-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p']
    return [
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      CQ,
      ...depth,
      '-x265-params',
      'log-level=error',
      ...color,
      '-tag:v',
      'hvc1'
    ]
  }
  if (!hevc && enc.h264_nvenc) {
    return [
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p6',
      '-tune',
      'hq',
      '-rc',
      'vbr',
      '-cq',
      CQ,
      '-b:v',
      '0',
      '-pix_fmt',
      'yuv420p',
      ...color
    ]
  }
  // No HEVC encoder: 10-bit H.264 keeps the depth (ffmpeg reads it fine; the
  // preview plays the 8-bit proxy anyway).
  const depth = tenBit ? ['-profile:v', 'high10', '-pix_fmt', 'yuv420p10le'] : ['-pix_fmt', 'yuv420p']
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', CQ, ...depth, ...color]
}

/**
 * One piece → one file. `-ss` before `-i` with a re-encode is frame-exact:
 * the output holds the source frames with pts in [inSec, outSec), so pieces
 * split at one point share no frame and lose none. Source timestamps pass
 * through (iPhone footage is VFR). Only the first video and audio streams are
 * kept (iPhone files carry several metadata tracks).
 */
export function buildCutArgs(
  input: string,
  output: string,
  probe: ProbeInfo,
  piece: CutPiece,
  enc: FfmpegEncoders
): string[] {
  if (!probe.video) throw new Error('Quick cut needs a video clip.')
  const dec = alphaInputDecoder(probe.video)
  const alpha = !!probe.video.hasAlpha
  // The length from the ROUNDED start, so the piece still ends exactly at outSec.
  const start = f3(piece.inSec)
  const audio = probe.audio
    ? ['-map', '0:a:0?', ...(alpha ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '256k'])]
    : ['-an']
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...(dec ? ['-c:v', dec] : []),
    '-ss',
    start,
    '-i',
    input,
    '-t',
    f3(piece.outSec - Number(start)),
    '-map',
    '0:v:0',
    '-map_metadata',
    '0',
    '-fps_mode',
    'passthrough',
    ...videoArgs(probe.video, enc),
    ...audio,
    ...(alpha ? [] : ['-movflags', '+faststart']),
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ]
}

/** Give a cut the original's transcript, re-timed to the piece (no whisper run). */
async function carryTranscript(
  session: ProjectSession,
  source: Transcript,
  piece: CutPiece,
  toId: string
): Promise<void> {
  const t: Transcript = {
    ...source,
    mediaId: toId,
    words: sliceWords(source.words, piece),
    ...(source.decodeStartSec !== undefined ? { decodeStartSec: Math.max(0, source.decodeStartSec - piece.inSec) } : {})
  }
  const path = transcriptFile(toId, session)
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await replaceFile(path, JSON.stringify(t, null, 2))
}

/**
 * Cut a library video into one new library clip per piece, in order. The
 * original stays as it is. Throws (before any encode) when the cut is invalid
 * or the clip unusable; a failed encode removes its partial file and fails
 * the whole call — pieces already adopted stay in the library.
 */
export async function cutToLibrary(mediaId: string, pieces: CutPiece[]): Promise<MediaAsset[]> {
  const session = requireSession() // the cut finishes in the project it started in
  const source = await requireUsable(mediaId, session)
  if (assetKind(source) !== 'video' || !source.probe.video) throw new Error(`${source.fileName} is not a video clip.`)
  const problem = cutProblem(pieces, source.probe.durationSec)
  if (problem) throw new Error(problem)

  const [{ ffmpeg }, caps] = await Promise.all([getBinaries(), getCapabilities()])
  const ext = cutExt(source.probe)
  const names = cutDisplayNames(source.fileName, pieces.length, ext)
  const transcript = source.probe.audio ? await getTranscript(mediaId, session) : null
  const total = pieces.reduce((s, p) => s + p.outSec - p.inSec, 0)

  const job = createJob('proxy', `Quick cut · ${source.fileName}`, undefined, { uses: [mediaId] })
  const made: MediaAsset[] = []
  try {
    let done = 0
    for (const [i, piece] of pieces.entries()) {
      const len = piece.outSec - piece.inSec
      const tmp = tmpOutput('cut', ext)
      await writeAtomically(tmp, (part) =>
        runFfmpeg(ffmpeg, buildCutArgs(source.originalPath, part, source.probe, piece, caps.encoders), len, (p) =>
          setProgress(job.id, (done + p * len) / total)
        )
      )
      done += len
      const asset = await importGenerated(tmp, names[i], session)
      if (transcript) await carryTranscript(session, transcript, piece, asset.id)
      made.push(asset)
    }
    finishJob(job.id)
  } catch (error) {
    failJob(job.id, error instanceof Error ? error.message : String(error))
    throw error
  }
  // Each cut needs its own preview proxy; build them in the background as for an import.
  for (const a of made) {
    if (!a.proxyReady) void ensureProxy(a.id, session).catch((err) => log.error(`proxy failed for ${a.id}`, err))
  }
  return made
}
