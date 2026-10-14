/** ffmpeg/ffprobe discovery + capability info, surfaced to the renderer. */

export interface FfmpegEncoders {
  h264_nvenc: boolean
  hevc_nvenc: boolean
  /** HEVC software encoder: the quick-cut fallback for HEVC / 10-bit sources without NVENC. */
  libx265: boolean
  libx264: boolean
  aac: boolean
}

export interface FfmpegFilters {
  ass: boolean
  subtitles: boolean
  zscale: boolean
  tonemap: boolean
  sidechaincompress: boolean
  showwavespic: boolean
}

export interface FfmpegCapabilities {
  found: boolean
  ffmpegPath: string | null
  ffprobePath: string | null
  version: string | null
  encoders: FfmpegEncoders
  filters: FfmpegFilters
  /** h264_nvenc present and usable for hardware encode. */
  nvencAvailable: boolean
  /** True when ffmpeg has everything the export/proxy pipelines require. */
  usable: boolean
  /** Human-readable reasons the build is not usable (empty when usable). */
  problems: string[]
}

export const EMPTY_CAPABILITIES: FfmpegCapabilities = {
  found: false,
  ffmpegPath: null,
  ffprobePath: null,
  version: null,
  encoders: { h264_nvenc: false, hevc_nvenc: false, libx264: false, libx265: false, aac: false },
  filters: {
    ass: false,
    subtitles: false,
    zscale: false,
    tonemap: false,
    sidechaincompress: false,
    showwavespic: false
  },
  nvencAvailable: false,
  usable: false,
  problems: ['ffmpeg not found']
}
