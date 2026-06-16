/**
 * Audio-only media: a small AAC proxy the renderer can play, plus a waveform
 * PNG for the timeline music lane. Arg builders are pure (unit-tested).
 */

import { getBinaries } from './ffmpeg'
import { runFfmpeg } from './ffmpegRun'

export function buildAudioProxyArgs(input: string, output: string): string[] {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-i', input,
    '-vn',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    output
  ]
}

export function buildWaveformArgs(input: string, output: string, width = 1600, height = 200): string[] {
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
    const parts = [
      `[${it.inputLabel}]atrim=${it.inSec.toFixed(3)}:${it.outSec.toFixed(3)}`,
      'asetpts=N/SR/TB',
      `adelay=${startMs}|${startMs}`,
      `volume=${gain}`
    ]
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

export async function generateAudioProxy(input: string, output: string): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await run(ffmpeg, buildAudioProxyArgs(input, output))
}

export async function generateWaveform(input: string, output: string): Promise<void> {
  const { ffmpeg } = await getBinaries()
  await run(ffmpeg, buildWaveformArgs(input, output))
}
