/**
 * Audio-only media: a small AAC proxy the renderer can play, plus a waveform
 * PNG for the timeline music lane. Arg builders are pure (unit-tested).
 */

import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'

export function buildAudioProxyArgs(
  input: string,
  output: string,
  foldChannel: number | null = null
): string[] {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-i', input,
    '-vn',
    ...(foldChannel != null ? ['-af', monoFoldPan(foldChannel)] : []),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    output
  ]
}

/**
 * Mirror one channel of a stereo source to BOTH output channels. Used for the
 * "mono mic recorded to a single side" case: without it that footage plays out
 * of one ear (and can read as silent). `channel` is 0 = left, 1 = right.
 * Verified against ffmpeg 8.1.1 — see docs/FFMPEG-NOTES.md. */
export function monoFoldPan(channel: number): string {
  return `pan=stereo|c0=c${channel}|c1=c${channel}`
}

/** A channel whose peak sits below this (dBFS) is treated as silent/dead. */
const SILENCE_PEAK_DB = -60

/**
 * ffmpeg args that print each channel's peak level (and nothing else) to stderr
 * for a one-shot level probe. Decodes the whole audio stream to a null sink —
 * cheap for Reel-length clips. Pair with `parseChannelPeaks` + `monoFoldFrom`.
 */
export function buildChannelStatsArgs(input: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-i', input,
    '-map', '0:a:0',
    '-af', 'astats=measure_perchannel=Peak_level:measure_overall=none',
    '-f', 'null', '-'
  ]
}

/** Parse per-channel peak levels (dBFS) out of `astats` stderr; index 0 = ch1. */
export function parseChannelPeaks(stderr: string): number[] {
  const peaks: number[] = []
  let cur = -1
  for (const line of stderr.split(/\r?\n/)) {
    const ch = line.match(/Channel:\s*(\d+)/)
    if (ch) {
      cur = Number(ch[1]) - 1
      continue
    }
    const pk = line.match(/Peak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i)
    if (pk && cur >= 0) {
      peaks[cur] = /inf/i.test(pk[1]) ? -Infinity : Number(pk[1])
      cur = -1
    }
  }
  return peaks
}

/**
 * Given per-channel peaks, decide the mono-fold channel: only for a 2-channel
 * source where exactly one channel is live and the other is silent, return the
 * live one's index; otherwise `null` (true stereo, mono, or dead silence — no
 * fold). See `AudioStreamInfo.monoFoldChannel`.
 */
export function monoFoldFrom(peaksDb: number[]): number | null {
  if (peaksDb.length !== 2) return null
  const live = peaksDb.map((p) => p > SILENCE_PEAK_DB)
  if (live[0] && !live[1]) return 0
  if (live[1] && !live[0]) return 1
  return null
}

/**
 * Pull a source file's audio into a standalone WAV (lossless PCM) — the "original"
 * for an extracted-audio library asset. A small AAC proxy is generated separately
 * by the normal import pipeline for playback.
 */
export function buildExtractAudioArgs(input: string, output: string): string[] {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-i', input,
    '-vn',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    output
  ]
}

export function buildWaveformArgs(input: string, output: string, durationSec = 0): string[] {
  // Scale the PNG width to the clip length (~120 px/s) so it stays crisp at
  // realistic zoom, clamped to a sane range. Still raster — for sample-level
  // zoom a canvas-from-peaks renderer would be the next step.
  const width = Math.round(Math.min(6000, Math.max(2000, durationSec * 120)))
  const height = 320
  return [
    '-y', '-hide_banner', '-nostdin',
    '-i', input,
    '-filter_complex',
    `aformat=channel_layouts=mono,compand,showwavespic=s=${width}x${height}:colors=#38bdf8,format=rgba`,
    '-frames:v', '1',
    output
  ]
}

/** dB → linear gain (e.g. -14 dB → ~0.2). */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export interface AudioGraphItem {
  /** ffmpeg input pad, e.g. "1:a". */
  inputLabel: string
  startSec: number
  inSec: number
  /** Effective source out-point (already resolved). */
  outSec: number
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
  /** Duck under the non-ducked sources (dialogue + non-duck clips). */
  duck: boolean
  /** Apply FFT noise reduction. */
  denoise?: boolean
  /** Mirror this stereo channel to both sides (mono-fold), or null. See
   *  `AudioStreamInfo.monoFoldChannel`. */
  foldChannel?: number | null
  /** Pitch-preserving tempo factor (a re-timed video layer's own audio; 1 =
   *  normal). Applied as an `atempo` chain — each stage only accepts 0.5–2. */
  tempo?: number
}

/** `atempo` filter chain for an arbitrary tempo: factored into stages within
 *  the filter's [0.5, 2] per-instance range (e.g. 4 → 2×2, 0.25 → 0.5×0.5). */
export function atempoChain(tempo: number): string[] {
  if (!Number.isFinite(tempo) || tempo <= 0 || tempo === 1) return []
  const stages: string[] = []
  let t = tempo
  while (t > 2) {
    stages.push('atempo=2.000')
    t /= 2
  }
  while (t < 0.5) {
    stages.push('atempo=0.500')
    t /= 0.5
  }
  stages.push(`atempo=${t.toFixed(3)}`)
  return stages
}

/**
 * Build the export audio filter_complex: each audio clip is trimmed, delayed to
 * its timeline position, gained and faded; ducked clips (music beds) are
 * sidechained under everything else, then all are amix'd. `dialogueLabel` is the
 * concatenated clips' audio (e.g. "0:a"). Pure + unit-tested.
 */
export function buildAudioGraph(
  items: AudioGraphItem[],
  dialogueLabel: string | null
): { filter: string; outLabel: string } | null {
  const chains: string[] = []
  const nonDucked: string[] = []
  const ducked: string[] = []
  if (dialogueLabel) nonDucked.push(dialogueLabel)

  items.forEach((it, i) => {
    const gain = dbToGain(it.gainDb).toFixed(3)
    const startMs = Math.round(Math.max(0, it.startSec) * 1000)
    const clipEnd = it.startSec + Math.max(0.01, it.outSec - it.inSec)
    const fold = it.foldChannel != null ? `${monoFoldPan(it.foldChannel)},` : ''
    const parts = [
      `[${it.inputLabel}]${fold}atrim=${it.inSec.toFixed(3)}:${it.outSec.toFixed(3)}`,
      'asetpts=N/SR/TB'
    ]
    // Tempo before the delay: atempo rescales the trimmed clip's duration, then
    // adelay places the shortened/stretched result at its timeline position.
    if (it.tempo != null && it.tempo !== 1) parts.push(...atempoChain(it.tempo))
    if (it.denoise) parts.push('afftdn=nf=-25')
    parts.push(`adelay=${startMs}|${startMs}`, `volume=${gain}`)
    if (it.fadeInSec > 0)
      parts.push(`afade=t=in:st=${it.startSec.toFixed(2)}:d=${it.fadeInSec.toFixed(2)}`)
    if (it.fadeOutSec > 0)
      parts.push(`afade=t=out:st=${Math.max(0, clipEnd - it.fadeOutSec).toFixed(2)}:d=${it.fadeOutSec.toFixed(2)}`)
    const label = `ac${i}`
    chains.push(`${parts.join(',')}[${label}]`)
    ;(it.duck ? ducked : nonDucked).push(label)
  })

  if (nonDucked.length === 0 && ducked.length === 0) return null

  const mixInto = (labels: string[], out: string): void => {
    if (labels.length === 1) chains.push(`[${labels[0]}]anull[${out}]`)
    else chains.push(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0[${out}]`)
  }

  if (ducked.length === 0) {
    mixInto(nonDucked, 'aout')
  } else if (nonDucked.length === 0) {
    mixInto(ducked, 'aout')
  } else {
    mixInto(nonDucked, 'nd')
    mixInto(ducked, 'dk')
    chains.push('[nd]asplit=2[nd_sc][nd_mix]')
    chains.push('[dk][nd_sc]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[dk2]')
    chains.push('[dk2][nd_mix]amix=inputs=2:normalize=0[aout]')
  }
  return { filter: chains.join(';'), outLabel: 'aout' }
}

function run(ffmpeg: string, args: string[]): Promise<void> {
  return runFfmpeg(ffmpeg, args, 0)
}

export async function generateAudioProxy(
  input: string,
  output: string,
  foldChannel: number | null = null
): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await run(ffmpeg, buildAudioProxyArgs(input, output, foldChannel))
}

/**
 * Level-probe a source's channels and, for the one-live-channel case, return the
 * channel to mono-fold (see `monoFoldFrom`). Best-effort: any failure (no audio,
 * odd container, ffmpeg error) resolves to `null` — this must never break import.
 */
export async function detectMonoFoldChannel(input: string): Promise<number | null> {
  try {
    const { ffmpeg } = await getBinaries()
    // astats logs to stderr; runFfmpeg tails stderr but doesn't return it, so
    // spawn directly here to capture the full level dump.
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stderr } = await execFileAsync(ffmpeg, buildChannelStatsArgs(input), {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return monoFoldFrom(parseChannelPeaks(stderr))
  } catch {
    return null
  }
}

export async function generateWaveform(input: string, output: string, durationSec = 0): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await run(ffmpeg, buildWaveformArgs(input, output, durationSec))
}

export async function extractAudio(input: string, output: string): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await run(ffmpeg, buildExtractAudioArgs(input, output))
}
