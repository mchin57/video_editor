/**
 * Audio-only media: a small AAC proxy the renderer can play, plus a waveform
 * PNG for the timeline music lane. Arg builders are pure (unit-tested).
 */

import type { MusicConfig } from '@shared/project'
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

/**
 * Build the export audio handling for the music bed. `clipAudio` is the
 * concatenated clips' audio label (e.g. "0:a"); `music` is the music input label
 * (e.g. "1:a"). Returns a filter_complex fragment producing "[aout]" plus the
 * output map label. Pure + unit-tested.
 */
export function buildMusicMixGraph(
  music: MusicConfig,
  clipAudioLabel: string,
  musicInputLabel: string,
  totalDurationSec: number
): { filter: string; outLabel: string } {
  const gain = dbToGain(music.volumeDb).toFixed(3)
  const fade =
    music.fadeOutSec > 0
      ? `,afade=t=out:st=${Math.max(0, totalDurationSec - music.fadeOutSec).toFixed(2)}:d=${music.fadeOutSec.toFixed(2)}`
      : ''
  // Trim music to the timeline length and shape it.
  const musicChain = `[${musicInputLabel}]atrim=0:${totalDurationSec.toFixed(2)},volume=${gain}${fade}[music]`

  if (music.muteVideo) {
    // Music only.
    return { filter: `${musicChain}`, outLabel: 'music' }
  }

  if (music.duck) {
    // Duck the music under the clip audio (sidechain), then mix. The clip audio
    // feeds both the sidechain and the mix, so it must be split first.
    return {
      filter:
        `${musicChain};` +
        `[${clipAudioLabel}]asplit=2[a_sc][a_mix];` +
        `[music][a_sc]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[ducked];` +
        `[ducked][a_mix]amix=inputs=2:normalize=0[aout]`,
      outLabel: 'aout'
    }
  }

  return {
    filter: `${musicChain};[music][${clipAudioLabel}]amix=inputs=2:normalize=0[aout]`,
    outLabel: 'aout'
  }
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
