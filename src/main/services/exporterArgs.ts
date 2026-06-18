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
import { isNeutralColor } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import { EXPORT_PRESETS, type PresetId } from '@shared/export'
import { hdrToSdrChain } from './proxy'

export interface Target {
  width: number
  height: number
}

/** A resolved image overlay for the final encode (geometry in output px). */
export interface ImageOverlayArg {
  /** Source PNG path (an extra ffmpeg input). */
  path: string
  x: number
  y: number
  w: number
  h: number
  startSec: number
  endSec: number
  /** 0..1 */
  opacity: number
  anchor: 'center' | 'topLeft'
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
  if (!isNeutralColor(clip.color)) {
    const c = clip.color!
    filters.push(`eq=brightness=${c.brightness}:contrast=${c.contrast}:saturation=${c.saturation}`)
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
  opts: {
    preferNvenc: boolean
    assFile?: string
    images?: ImageOverlayArg[]
    audio?: { inputPaths: string[]; filter: string; outLabel: string }
  }
): string[] {
  const nvenc = opts.preferNvenc && caps.encoders.h264_nvenc
  const videoArgs = nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']

  // Input order: concat (0), then audio inputs, then image inputs. Image input
  // indices therefore start after the audio inputs.
  const audioCount = opts.audio?.inputPaths.length ?? 0
  const images = opts.images ?? []
  const inputs = ['-f', 'concat', '-safe', '0', '-i', listPath]
  for (const p of opts.audio?.inputPaths ?? []) inputs.push('-i', p)
  for (const im of images) inputs.push('-i', im.path)

  let filterArgs: string[] = []
  let mapArgs: string[] = []

  // Any image overlay or audio mix forces filter_complex (can't combine with -vf).
  if (images.length > 0 || opts.audio) {
    const chains: string[] = []
    let vlabel = '0:v'

    // Composite each image (scale → alpha → opacity → overlay), gated by time.
    images.forEach((im, k) => {
      const inputIdx = 1 + audioCount + k
      const w = Math.round(im.w)
      const h = Math.round(im.h)
      const x = Math.round(im.anchor === 'center' ? im.x - im.w / 2 : im.x)
      const y = Math.round(im.anchor === 'center' ? im.y - im.h / 2 : im.y)
      const op = Math.max(0, Math.min(1, im.opacity))
      const prep =
        `[${inputIdx}:v]scale=${w}:${h},format=rgba` +
        (op < 0.999 ? `,colorchannelmixer=aa=${op.toFixed(3)}` : '')
      chains.push(`${prep}[oimg${k}]`)
      const out = `vi${k}`
      chains.push(
        `[${vlabel}][oimg${k}]overlay=${x}:${y}:enable='between(t,${im.startSec.toFixed(3)},${im.endSec.toFixed(3)})'[${out}]`
      )
      vlabel = out
    })

    // Burn text overlays / captions on top of the images.
    if (opts.assFile) {
      chains.push(`[${vlabel}]ass=${opts.assFile}[v]`)
      vlabel = 'v'
    }

    const videoMap = vlabel === '0:v' ? '0:v' : `[${vlabel}]`
    if (opts.audio) {
      chains.push(opts.audio.filter)
      mapArgs = ['-map', videoMap, '-map', `[${opts.audio.outLabel}]`]
    } else {
      // No custom audio graph → keep the concat's own audio track.
      mapArgs = ['-map', videoMap, '-map', '0:a?']
    }
    filterArgs = ['-filter_complex', chains.join(';')]
  } else if (opts.assFile) {
    // Burn overlays/captions via the ass video filter.
    filterArgs = ['-vf', `ass=${opts.assFile}`]
  }

  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...inputs,
    ...filterArgs,
    ...mapArgs,
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
