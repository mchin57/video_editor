/**
 * PURE ffprobe-JSON → ProbeInfo parser. No electron/node-runtime deps so it can
 * be unit-tested against captured fixtures. The thin runner lives in ffprobe.ts.
 *
 * iPhone footage is the priority case, which means three things must be right:
 *   - rotation: stored landscape + a 90/270° display matrix → portrait display
 *   - VFR: avg_frame_rate differs from r_frame_rate
 *   - HDR: PQ (smpte2084) / HLG (arib-std-b67) transfer needs tone-mapping
 */

import type { ProbeInfo, VideoStreamInfo, AudioStreamInfo } from '@shared/media'

interface RawSideData {
  side_data_type?: string
  rotation?: number
}

interface RawStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  color_transfer?: string
  color_primaries?: string
  color_space?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
  side_data_list?: RawSideData[]
  tags?: Record<string, string>
}

interface RawFormat {
  duration?: string
  format_name?: string
}

export interface FfprobeJson {
  streams?: RawStream[]
  format?: RawFormat
}

/** Parse an ffprobe rational like "30000/1001" into fps. Returns 0 when unknown. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den)) return 0
  return num / den
}

/** Snap an arbitrary rotation (possibly negative) to one of 0/90/180/270. */
export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const n = (((Math.round(deg / 90) * 90) % 360) + 360) % 360
  return n as 0 | 90 | 180 | 270
}

function extractRotation(stream: RawStream): number {
  const sd = stream.side_data_list?.find(
    (s) => typeof s.rotation === 'number' && Number.isFinite(s.rotation)
  )
  if (sd && typeof sd.rotation === 'number') return normalizeRotation(sd.rotation)
  const tag = stream.tags?.rotate ?? stream.tags?.['rotate']
  if (tag !== undefined) {
    const n = Number(tag)
    if (Number.isFinite(n)) return normalizeRotation(n)
  }
  return 0
}

const HDR_TRANSFERS = new Set(['smpte2084', 'smptest2084', 'arib-std-b67'])

/** Treat ffprobe's "unknown"/"reserved"/"N/A" placeholders as absent. */
function cleanColor(v: string | undefined): string | null {
  if (!v || v === 'unknown' || v === 'reserved' || v === 'N/A') return null
  return v
}

/** avg vs r frame rate disagreeing by >2% is our VFR signal. */
function detectVfr(avgFps: number, rFps: number): boolean {
  if (avgFps <= 0 || rFps <= 0) return false
  const diff = Math.abs(avgFps - rFps)
  return diff / Math.max(avgFps, rFps) > 0.02
}

function parseVideo(s: RawStream): VideoStreamInfo {
  const width = s.width ?? 0
  const height = s.height ?? 0
  const rotationDeg = extractRotation(s)
  const swap = rotationDeg === 90 || rotationDeg === 270
  const avgFps = parseRate(s.avg_frame_rate)
  const rFps = parseRate(s.r_frame_rate)
  const transfer = cleanColor(s.color_transfer)
  return {
    codec: s.codec_name ?? 'unknown',
    width,
    height,
    displayWidth: swap ? height : width,
    displayHeight: swap ? width : height,
    rotationDeg,
    avgFps,
    rFps,
    isVfr: detectVfr(avgFps, rFps),
    pixFmt: s.pix_fmt ?? 'unknown',
    colorTransfer: transfer,
    colorPrimaries: cleanColor(s.color_primaries),
    colorSpace: cleanColor(s.color_space),
    isHdr: transfer !== null && HDR_TRANSFERS.has(transfer)
  }
}

function parseAudio(s: RawStream): AudioStreamInfo {
  return {
    codec: s.codec_name ?? 'unknown',
    sampleRate: Number(s.sample_rate ?? 0) || 0,
    channels: s.channels ?? 0
  }
}

export function parseFfprobeJson(json: FfprobeJson): ProbeInfo {
  const streams = json.streams ?? []
  const videoStream = streams.find((s) => s.codec_type === 'video')
  const audioStream = streams.find((s) => s.codec_type === 'audio')

  const durationSec =
    Number(json.format?.duration) ||
    Number(videoStream?.duration) ||
    Number(audioStream?.duration) ||
    0

  return {
    durationSec,
    container: json.format?.format_name ?? 'unknown',
    video: videoStream ? parseVideo(videoStream) : null,
    audio: audioStream ? parseAudio(audioStream) : null
  }
}
