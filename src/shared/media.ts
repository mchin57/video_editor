/** Probed facts about a source media file, and the imported asset record. */

export interface VideoStreamInfo {
  codec: string
  /** Stored (pre-rotation) pixel dimensions. */
  width: number
  height: number
  /** Display dimensions after applying rotation metadata. */
  displayWidth: number
  displayHeight: number
  /** Rotation in degrees from displaymatrix side data (0, 90, 180, 270). */
  rotationDeg: number
  /** avg_frame_rate as a number (frames per second). */
  avgFps: number
  /** r_frame_rate as a number. Differs from avgFps for variable-frame-rate sources. */
  rFps: number
  /** True when the source is variable frame rate (iPhone footage usually is). */
  isVfr: boolean
  pixFmt: string
  colorTransfer: string | null
  colorPrimaries: string | null
  colorSpace: string | null
  /** True for PQ (smpte2084) or HLG (arib-std-b67) transfer — needs tone-mapping. */
  isHdr: boolean
}

export interface AudioStreamInfo {
  codec: string
  sampleRate: number
  channels: number
}

export interface ProbeInfo {
  durationSec: number
  container: string
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
}

export interface MediaAsset {
  /** Content hash (first 12 hex of sha1) — also the media folder name. */
  id: string
  fileName: string
  originalPath: string
  importedAt: string
  probe: ProbeInfo
  proxyReady: boolean
  /** Whether a transcript.json has been generated. */
  transcribed: boolean
}
