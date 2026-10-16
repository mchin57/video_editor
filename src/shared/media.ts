/** Probed facts about a source media file, and the imported asset record. */

export interface VideoStreamInfo {
  codec: string
  /** Stored (pre-rotation) pixel dimensions. */
  width: number
  height: number
  /** Display dimensions after applying rotation metadata. */
  displayWidth: number
  displayHeight: number
  /** Rotation in degrees from displaymatrix side data (0, 90, 180, 270): the
   *  stream's (video), or the first frame's (a still's EXIF orientation). */
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
  /** True when the stream carries an alpha channel. Set for background-removed
   *  clips so preview + export keep transparency instead of flattening to
   *  yuv420p. NB: for VP8/VP9 WebM the alpha lives in a container side-band —
   *  ffprobe reports `pix_fmt=yuv420p` and signals alpha only via the
   *  `alpha_mode=1` stream tag (see ffprobeParse). Absent on assets probed
   *  before this field existed. */
  hasAlpha?: boolean
}

export interface AudioStreamInfo {
  codec: string
  sampleRate: number
  channels: number
  /**
   * MEASURED at import (astats level probe, not ffprobe JSON): when a stereo
   * source has exactly one live channel and the other is silent — the common
   * "mono mic wired to one side" case — the index (0 = L, 1 = R) of the live
   * channel. Drives an automatic mono-fold (`monoFoldPan`) that mirrors that
   * channel to both sides in the preview proxies and the export mix. `null`
   * (or absent, on assets imported before this field) = both channels carry
   * signal (true stereo) or both are silent → no fold. */
  monoFoldChannel?: number | null
}

export interface ProbeInfo {
  durationSec: number
  container: string
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
  /** Which parser made this probe (`PROBE_VERSION` in main's ffprobeParse);
   *  absent = before versions. Records whose probe is stale are re-probed on
   *  open. */
  version?: number
}

export type MediaKind = 'video' | 'audio' | 'image'

/**
 * What identifies an original without reading all of it (docs/MEDIA-POINTERS.md):
 * its size plus sha1 hex digests of three fixed-size samples (start, middle,
 * end). A file small enough that the samples would overlap is hashed whole,
 * and that one digest fills all three fields.
 */
export interface Fingerprint {
  size: number
  start: string
  middle: string
  end: string
}

/** The fingerprint fields, as named in the relink mismatch warning. */
export type FingerprintField = keyof Fingerprint

/**
 * A library item as SAVED in the `.reel` (docs/MEDIA-POINTERS.md "A library
 * item"). It points at the original where the user keeps it; nothing is
 * copied. Main owns these in memory for the open project; only Save writes them.
 */
export interface MediaRecord {
  /** Stable id the timeline references. Fingerprint-derived for new imports;
   *  pre-pointer clips keep their old content-hash ids. */
  id: string
  /** Display name (the original's file name at import). */
  fileName: string
  /** From the `.reel`'s folder to the original, '/'-separated. Null when the
   *  original is on another drive (no relative path exists). Tried FIRST. */
  relativePath: string | null
  /** Full path where the original was imported from or last found. Tried second. */
  absolutePath: string
  fingerprint: Fingerprint
  /** Made by the editor (background removal, audio fx, extracted audio,
   *  stills); its file lives in the project's `generated/`. */
  generated?: boolean
  importedAt: string
  probe: ProbeInfo
  kind: MediaKind
  /** The user's (or the assistant's) note about what is in the clip, shown on
   *  hover in the library and the timeline. Absent = none. Per FILE: every
   *  timeline placement of the clip shows the same one. */
  description?: string
}

/** Longest description kept (a few paragraphs). */
export const DESCRIPTION_MAX = 2000

/** A description as stored: Windows line endings folded, ends trimmed, capped.
 *  '' means "no description". */
export function normalizeDescription(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, DESCRIPTION_MAX)
}

/** Whether a library item's original was found this session (checked by main
 *  on open and on every library load): `missing` = neither its relative nor
 *  its absolute path holds a file matching its fingerprint. */
export type MediaStatus = 'ok' | 'missing'

/** Display name of a placeholder for a clip the project uses but nothing
 *  describes (main/services/unknownMedia.ts). */
export const UNKNOWN_CLIP_NAME = 'Unknown clip'

/** A placeholder record: the project uses the clip, but no record says which
 *  file it was (an empty absolute path). Relink fills it in. */
export const isUnknownClip = (r: Pick<MediaRecord, 'absolutePath'>): boolean => r.absolutePath === ''

/** A library item as the app uses it: the saved record plus runtime facts. */
export interface MediaAsset extends MediaRecord {
  /** Absolute path of the original to READ: where it was found this session,
   *  else (missing) the record's absolute path. Runtime only. */
  originalPath: string
  /** Runtime only: the latest check. */
  status?: MediaStatus
  proxyReady: boolean
  /** Whether a transcript exists in the project's transcripts/. */
  transcribed: boolean
  /** Runtime only: the content's revision (from its fingerprint). It changes
   *  exactly when the clip's content does — "Update path anyway" — and every
   *  `reelmedia://` URL carries it, so players and images reload instead of
   *  keeping the old proxy (same id, same file name). */
  rev?: string
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

/**
 * A class claimed by name (the extension, or a stored kind) checked against
 * the probed streams. A video container with no picture is audio: an `.mp4`
 * can hold only AAC (or an MP3 renamed `.mp4`), and the video proxy's
 * `-map 0:v:0` fails on it (docs/FFMPEG-NOTES.md "Audio-only video
 * containers"). Anything else keeps its claim, and no claim falls back to the
 * probe alone.
 */
export function reconcileKind(claimed: MediaKind | null | undefined, probe: ProbeInfo): MediaKind {
  if (claimed === 'video' && !probe.video && probe.audio) return 'audio'
  return claimed ?? deriveKind(probe)
}

/** The class of a newly probed file: its extension, checked against the probe. */
export function kindOfFile(path: string, probe: ProbeInfo): MediaKind {
  return reconcileKind(kindFromExt(path), probe)
}

/** The asset's class: the stored kind checked against the probe (which also
 *  corrects records saved as 'video' before the probe was consulted), else
 *  derived. */
export function assetKind(a: MediaAsset): MediaKind {
  return reconcileKind(a.kind, a.probe)
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

/**
 * The decoder ffmpeg must be forced to (`-c:v <name>` placed BEFORE that `-i`)
 * for an alpha video's transparency to survive decoding. VP8/VP9 store alpha as
 * a Matroska side-band the native decoders silently drop — only the libvpx
 * decoders read it (verified against ffmpeg 8.1: default decode of a yuva420p
 * VP9 WebM yields a fully-opaque alpha plane). Null = no forcing needed: either
 * no alpha, or a codec whose default decoder carries it (e.g. ProRes 4444).
 */
export function alphaInputDecoder(
  v: Pick<VideoStreamInfo, 'codec' | 'hasAlpha'> | null | undefined
): string | null {
  if (!v?.hasAlpha) return null
  if (v.codec === 'vp9') return 'libvpx-vp9'
  if (v.codec === 'vp8') return 'libvpx'
  return null
}

export const isImageAsset = (a: MediaAsset): boolean => assetKind(a) === 'image'
export const isAudioAsset = (a: MediaAsset): boolean => assetKind(a) === 'audio'
export const isVideoAsset = (a: MediaAsset): boolean => assetKind(a) === 'video'

/** A visual asset's display aspect (w/h), or undefined when its probe has no
 *  usable picture size (audio, or a failed probe). Fits new layers to the frame. */
export function assetAspect(a: Pick<MediaAsset, 'probe'> | undefined): number | undefined {
  const v = a?.probe.video
  return v && v.displayWidth > 0 && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : undefined
}
