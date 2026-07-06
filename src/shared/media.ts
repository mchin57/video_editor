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
  /** True when the pixel format carries an alpha channel (e.g. yuva420p). Set for
   *  background-removed clips so preview + export keep transparency instead of
   *  flattening to yuv420p. Absent on assets probed before this field existed. */
  hasAlpha?: boolean
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

export type MediaKind = 'video' | 'audio' | 'image'

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
  /** Coarse media class. Optional for assets imported before this field existed
   * (derived from the probe via {@link assetKind} as a fallback). */
  kind?: MediaKind
}

/** Source extensions we recognise, by class. Drive the import dialog + kind. */
export const VIDEO_EXTS = [
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'hevc', '3gp', 'wmv', 'flv', 'mts', 'm2ts', 'mpg', 'mpeg'
]
export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma']
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif']

/** Classify a path by extension (null when unrecognised). */
export function kindFromExt(path: string): MediaKind | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  return null
}

/** Best-effort class from the probe alone (for assets without a stored kind). */
export function deriveKind(probe: ProbeInfo): MediaKind {
  if (!probe.video && probe.audio) return 'audio'
  if (probe.video && probe.durationSec === 0) return 'image'
  return 'video'
}

/** The asset's class, using the stored kind when present, else derived. */
export function assetKind(a: MediaAsset): MediaKind {
  return a.kind ?? deriveKind(a.probe)
}

/** Whether an ffprobe pixel-format name carries an alpha channel. Covers the
 *  planar YUV+alpha (`yuva*`), gray+alpha (`ya*`), packed RGB+alpha, and planar
 *  GBR+alpha (`gbrap*`) families. */
export function pixFmtHasAlpha(pixFmt: string | undefined | null): boolean {
  if (!pixFmt) return false
  return (
    /^yuva/.test(pixFmt) ||
    /^ya(8|16)?$/.test(pixFmt) ||
    /^gbrap/.test(pixFmt) ||
    ['rgba', 'argb', 'abgr', 'bgra', 'rgba64be', 'rgba64le'].includes(pixFmt)
  )
}

export const isImageAsset = (a: MediaAsset): boolean => assetKind(a) === 'image'
export const isAudioAsset = (a: MediaAsset): boolean => assetKind(a) === 'audio'
export const isVideoAsset = (a: MediaAsset): boolean => assetKind(a) === 'video'
