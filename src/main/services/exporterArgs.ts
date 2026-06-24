/**
 * PURE ffmpeg arg builder for the single-pass LAYER COMPOSITOR export.
 *
 * Unlike the old sequence-based exporter (normalize each clip → concat), the new
 * model composites the unified layer stack in one filter_complex: a black base
 * canvas the length of the project, then every visual layer overlaid in z-order —
 * videos and images scaled to their display box, positioned at their center, and
 * time-gated to their window; text layers burned via per-layer ASS so the full
 * back-to-front order (including text under video) is honored. Audio mixes all
 * audio clips + any unmuted video-layer audio. Geometry arrives already resolved
 * to OUTPUT pixels so this stays a pure string-assembler (unit-tested).
 */

import type { FfmpegCapabilities } from '@shared/ffmpeg'
import { EXPORT_PRESETS, type PresetId } from '@shared/export'
import { buildAudioGraph, type AudioGraphItem } from './audio'

export interface Target {
  width: number
  height: number
}

export function targetForPreset(preset: PresetId): Target {
  const p = EXPORT_PRESETS[preset]
  return { width: p.width, height: p.height }
}

/** A video layer resolved for compositing (geometry in output px). */
export interface ExportVideo {
  path: string
  /** Input seek + read duration (source seconds). */
  inSec: number
  len: number
  /** Precomputed HDR→SDR tonemap chain, or '' (none). */
  hdrChain: string
  /** Source-pixel crop, or null. */
  crop: { x: number; y: number; w: number; h: number } | null
  /** Precomputed eq filter (color correction), or '' (neutral). */
  colorEq: string
  /** Display box in output px. */
  boxW: number
  boxH: number
  /** Overlay top-left in output px. */
  x: number
  y: number
  /** Timeline window (seconds). */
  startSec: number
  endSec: number
}

/** An image layer resolved for compositing (geometry in output px). */
export interface ExportImage {
  path: string
  boxW: number
  boxH: number
  x: number
  y: number
  startSec: number
  endSec: number
  /** 0..1 */
  opacity: number
}

/** A visual layer, in back→front order. Text is burned via its own ASS file. */
export type ExportVisual =
  | { kind: 'video'; video: ExportVideo }
  | { kind: 'image'; image: ExportImage }
  | { kind: 'text'; assFile: string }

/** An audio source to mix (a video layer's audio, or an audio clip). */
export interface ExportAudio {
  path: string
  inSec: number
  outSec: number
  startSec: number
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
  duck: boolean
  denoise?: boolean
}

export interface ExportPlan {
  target: Target
  /** Project duration (seconds) — length of the black base canvas. */
  totalDur: number
  /** Visual layers, back (index 0 = background) → front. */
  visuals: ExportVisual[]
  audio: ExportAudio[]
  /** Relative ASS filename for the caption track (burned on top), if any. */
  captionsAss?: string
  caps: FfmpegCapabilities
  preferNvenc: boolean
}

const f3 = (n: number): string => n.toFixed(3)
const r = (n: number): number => Math.round(n)

/**
 * Assemble the full ffmpeg command for the compositor. `output` and any
 * `assFile` references are resolved relative to ffmpeg's cwd (the temp dir).
 */
export function buildExportArgs(plan: ExportPlan, output: string): string[] {
  const { target, totalDur, visuals, audio, captionsAss, caps, preferNvenc } = plan
  const W = target.width
  const H = target.height

  // Input indices: 0 = black base, then videos, then images, then audio.
  const videos = visuals.flatMap((v) => (v.kind === 'video' ? [v.video] : []))
  const images = visuals.flatMap((v) => (v.kind === 'image' ? [v.image] : []))
  const videoIdx = new Map<ExportVideo, number>()
  const imageIdx = new Map<ExportImage, number>()
  let idx = 1
  for (const v of videos) videoIdx.set(v, idx++)
  for (const im of images) imageIdx.set(im, idx++)
  const audioBase = idx

  const inputs: string[] = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=${f3(totalDur)}`]
  for (const v of videos) inputs.push('-ss', f3(v.inSec), '-t', f3(Math.max(0.01, v.len)), '-i', v.path)
  for (const im of images) inputs.push('-i', im.path)
  for (const a of audio) inputs.push('-i', a.path)

  // Video filtergraph: overlay/ass each visual onto the running composite.
  const chains: string[] = []
  let prev = '0:v'
  let step = 0
  for (const vis of visuals) {
    const out = `v${step++}`
    if (vis.kind === 'video') {
      const v = vis.video
      const i = videoIdx.get(v)!
      const pre: string[] = []
      if (v.hdrChain) pre.push(v.hdrChain)
      if (v.crop) pre.push(`crop=${r(v.crop.w)}:${r(v.crop.h)}:${r(v.crop.x)}:${r(v.crop.y)}`)
      pre.push(`scale=${r(v.boxW)}:${r(v.boxH)}:flags=bicubic`)
      if (v.colorEq) pre.push(v.colorEq)
      pre.push('setsar=1', 'format=yuv420p', `setpts=PTS-STARTPTS+${f3(v.startSec)}/TB`)
      chains.push(`[${i}:v]${pre.join(',')}[pv${i}]`)
      chains.push(
        `[${prev}][pv${i}]overlay=${r(v.x)}:${r(v.y)}:enable='between(t,${f3(v.startSec)},${f3(v.endSec)})':eof_action=pass[${out}]`
      )
    } else if (vis.kind === 'image') {
      const im = vis.image
      const i = imageIdx.get(im)!
      const op = Math.max(0, Math.min(1, im.opacity))
      const prep =
        `[${i}:v]scale=${r(im.boxW)}:${r(im.boxH)},format=rgba` +
        (op < 0.999 ? `,colorchannelmixer=aa=${op.toFixed(3)}` : '')
      chains.push(`${prep}[pi${i}]`)
      chains.push(
        `[${prev}][pi${i}]overlay=${r(im.x)}:${r(im.y)}:enable='between(t,${f3(im.startSec)},${f3(im.endSec)})'[${out}]`
      )
    } else {
      chains.push(`[${prev}]ass=${vis.assFile}[${out}]`)
    }
    prev = out
  }
  if (captionsAss) {
    const out = `v${step++}`
    chains.push(`[${prev}]ass=${captionsAss}[${out}]`)
    prev = out
  }
  const videoMap = `[${prev}]`

  // Audio: mix all sources (no concat "dialogue" base in the layer model).
  const audioItems: AudioGraphItem[] = audio.map((a, k) => ({
    inputLabel: `${audioBase + k}:a`,
    startSec: a.startSec,
    inSec: a.inSec,
    outSec: a.outSec,
    gainDb: a.gainDb,
    fadeInSec: a.fadeInSec,
    fadeOutSec: a.fadeOutSec,
    duck: a.duck,
    denoise: a.denoise
  }))
  const graph = audioItems.length > 0 ? buildAudioGraph(audioItems, null) : null
  if (graph) chains.push(graph.filter)

  const nvenc = preferNvenc && caps.encoders.h264_nvenc
  const videoArgs = nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']

  const mapArgs = ['-map', videoMap]
  if (graph) mapArgs.push('-map', `[${graph.outLabel}]`)

  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    ...mapArgs,
    ...videoArgs,
    '-r',
    '30',
    '-fps_mode',
    'cfr',
    '-pix_fmt',
    'yuv420p',
    ...(graph ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ]
}
