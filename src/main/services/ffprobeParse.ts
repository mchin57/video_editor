/**
 * PURE ffprobe-JSON → ProbeInfo parser. No electron/node-runtime deps so it can
 * be unit-tested against captured fixtures. The thin runner lives in ffprobe.ts.
 *
 * iPhone footage is the priority case, which means three things must be right:
 *   - rotation: stored landscape + a 90/270° display matrix → portrait display
 *   - VFR: avg_frame_rate differs from r_frame_rate
 *   - HDR: PQ (smpte2084) / HLG (arib-std-b67) transfer needs tone-mapping
 *   - photos: an iPhone JPEG is stored landscape and its EXIF orientation shows
 *     up only as the FIRST FRAME's display matrix, never on the stream — and
 *     ffmpeg applies it when decoding (docs/FFMPEG-NOTES.md "EXIF orientation")
 */

import type { MediaRecord, ProbeInfo, VideoStreamInfo, AudioStreamInfo } from '@shared/media'
import { pixFmtHasAlpha } from '@shared/media'

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

/** A decoded frame, as `-show_entries frame_side_data=…` prints it (the probe
 *  asks for a still's first frame only). */
interface RawFrame {
  side_data_list?: RawSideData[]
}

interface RawFormat {
  duration?: string
  format_name?: string
}

export interface FfprobeJson {
  streams?: RawStream[]
  format?: RawFormat
  frames?: RawFrame[]
}

/**
 * Bumped when the parser learns something records already saved lack; those
 * records are re-probed on open (`needsReprobe`). 2 = stills read their EXIF
 * orientation (2026-10-14).
 */
export const PROBE_VERSION = 2

/** A saved record whose probe predates what its kind needs: an image probed
 *  before v2 may hold landscape dimensions for a portrait photo. */
export function needsReprobe(r: Pick<MediaRecord, 'kind' | 'probe'>): boolean {
  return r.kind === 'image' && (r.probe.version ?? 1) < 2
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

/** A display-matrix rotation in a side-data list, snapped; null when none. */
function sideDataRotation(list: RawSideData[] | undefined): number | null {
  const sd = list?.find((s) => typeof s.rotation === 'number' && Number.isFinite(s.rotation))
  return sd && typeof sd.rotation === 'number' ? normalizeRotation(sd.rotation) : null
}

/** The stream's rotation (side data, then the legacy `rotate` tag), else the
 *  first frame's display matrix (a still's EXIF orientation; mirrored
 *  orientations report a rotation too, and ±90 still means "swap"). */
function extractRotation(stream: RawStream, frame: RawFrame | undefined): number {
  const sd = sideDataRotation(stream.side_data_list)
  if (sd !== null) return sd
  const tag = stream.tags?.rotate ?? stream.tags?.['rotate']
  if (tag !== undefined) {
    const n = Number(tag)
    if (Number.isFinite(n)) return normalizeRotation(n)
  }
  return sideDataRotation(frame?.side_data_list) ?? 0
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

function parseVideo(s: RawStream, frame: RawFrame | undefined): VideoStreamInfo {
  const width = s.width ?? 0
  const height = s.height ?? 0
  const rotationDeg = extractRotation(s, frame)
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
    isHdr: transfer !== null && HDR_TRANSFERS.has(transfer),
    // VP8/VP9 WebM alpha is a container side-band: pix_fmt stays yuv420p and the
    // only signal is the `alpha_mode=1` stream tag (verified against ffmpeg 8.1).
    hasAlpha: pixFmtHasAlpha(s.pix_fmt) || s.tags?.alpha_mode === '1'
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
    Number(json.format?.duration) || Number(videoStream?.duration) || Number(audioStream?.duration) || 0

  return {
    durationSec,
    container: json.format?.format_name ?? 'unknown',
    video: videoStream ? parseVideo(videoStream, json.frames?.[0]) : null,
    audio: audioStream ? parseAudio(audioStream) : null,
    version: PROBE_VERSION
  }
}
