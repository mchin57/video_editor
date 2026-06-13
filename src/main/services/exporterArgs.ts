/**
 * PURE ffmpeg arg builders for the two-phase export:
 *   1) normalize each clip → an identical-format intermediate (.mov, near-
 *      lossless H.264 + PCM 48k stereo) so the concat demuxer can join them
 *      without clicks or timestamp drift;
 *   2) concat the intermediates and encode once to the delivery file
 *      (NVENC when available, libx264 otherwise) + AAC.
 *
 * Kept dependency-light (only the shared HDR chain) so it's unit-testable.
 */

import type { Clip } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import { EXPORT_PRESETS, type PresetId } from '@shared/export'
import { hdrToSdrChain } from './proxy'

export interface Target {
  width: number
  height: number
}

export function targetForPreset(preset: PresetId): Target {
  const p = EXPORT_PRESETS[preset]
  return { width: p.width, height: p.height }
}

/**
 * Normalize one clip to the target frame. Trim (accurate seek), optional crop,
 * HDR tonemap, then either fill (when cropped to the target aspect) or fit+pad
 * (uncropped → matches the letterboxed preview). Audio is the clip's track
 * (with gain) or synthesized silence when muted/absent, so every segment has an
 * identical stream layout for the concat demuxer.
 */
export function buildNormalizeArgs(
  clip: Clip,
  asset: MediaAsset,
  target: Target,
  output: string
): string[] {
  const v = asset.probe.video
  const filters: string[] = []
  if (v?.isHdr) filters.push(hdrToSdrChain(v))

  if (clip.crop) {
    const c = clip.crop
    filters.push(
      `crop=${Math.round(c.w)}:${Math.round(c.h)}:${Math.round(c.x)}:${Math.round(c.y)}`,
      `scale=${target.width}:${target.height}:flags=bicubic`
    )
  } else {
    filters.push(
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=bicubic`,
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black`
    )
  }
  filters.push('setsar=1', 'format=yuv420p')

  const dur = Math.max(0.01, clip.outSec - clip.inSec).toFixed(3)
  const useRealAudio = Boolean(asset.probe.audio) && !clip.mute

  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-ss',
    clip.inSec.toFixed(3),
    '-i',
    asset.originalPath,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t',
    dur,
    '-map',
    '0:v:0',
    '-map',
    useRealAudio ? '0:a:0?' : '1:a:0',
    '-vf',
    filters.join(',')
  ]
  if (useRealAudio && clip.gainDb) args.push('-af', `volume=${clip.gainDb}dB`)
  args.push(
    '-r',
    '30',
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '14',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-video_track_timescale',
    '30000',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  )
  return args
}

/**
 * Concat the normalized segments and encode the delivery file once.
 * `assFile` is a filename RELATIVE to ffmpeg's cwd (the temp dir) — referencing
 * the ASS by relative name sidesteps the Windows drive-colon escaping mess in
 * filtergraph option values.
 */
export function buildFinalArgs(
  listPath: string,
  output: string,
  caps: FfmpegCapabilities,
  opts: { preferNvenc: boolean; assFile?: string }
): string[] {
  const nvenc = opts.preferNvenc && caps.encoders.h264_nvenc
  const videoArgs = nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']

  // Burn text overlays via the ass filter (re-encodes video, which we do anyway).
  const filterArgs = opts.assFile ? ['-vf', `ass=${opts.assFile}`] : []

  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    ...filterArgs,
    ...videoArgs,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ]
}
