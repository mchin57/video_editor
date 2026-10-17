/**
 * Silence detection for "split on silence". Runs ffmpeg's silencedetect over a
 * source and parses the stderr log into silent intervals (source seconds).
 * parseSilence is pure (unit-tested); detectSilence runs ffmpeg.
 */

import { spawn } from 'node:child_process'
import { getBinaries } from './ffmpeg'

export interface Interval {
  start: number
  end: number
}

export function buildSilenceArgs(input: string, noiseDb = -30, minSilenceSec = 0.4): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-i',
    input,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    '-f',
    'null',
    '-'
  ]
}

/** Parse silencedetect stderr into silent intervals. `durationSec` closes a
 *  trailing silence that has no silence_end (silence running to EOF). */
export function parseSilence(stderr: string, durationSec: number): Interval[] {
  const intervals: Interval[] = []
  let openStart: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) {
      openStart = Math.max(0, Number(s[1]))
      continue
    }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (e && openStart !== null) {
      intervals.push({ start: openStart, end: Number(e[1]) })
      openStart = null
    }
  }
  if (openStart !== null && durationSec > openStart) intervals.push({ start: openStart, end: durationSec })
  return intervals
}

export async function detectSilence(input: string, durationSec: number): Promise<Interval[]> {
  const { ffmpeg } = await getBinaries()
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, buildSilenceArgs(input), { windowsHide: true })
    let buf = ''
    child.stderr.on('data', (b: Buffer) => (buf += b.toString()))
    child.on('error', reject)
    child.on('close', () => resolve(buf))
  })
  return parseSilence(stderr, durationSec)
}
