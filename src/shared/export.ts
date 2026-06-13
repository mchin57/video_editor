/** Output presets. All vertical presets share the 1080x1920 logical space. */

export type PresetId = 'reel' | 'story' | 'square' | 'carousel'

export interface ExportPreset {
  id: PresetId
  name: string
  width: number
  height: number
  /** Optional fixed/maximum duration hint in seconds (carousel slides are short). */
  maxDurationSec?: number
}

export const EXPORT_PRESETS: Record<PresetId, ExportPreset> = {
  reel: { id: 'reel', name: 'Reel (9:16)', width: 1080, height: 1920 },
  story: { id: 'story', name: 'Story (9:16)', width: 1080, height: 1920 },
  square: { id: 'square', name: 'Square (1:1)', width: 1080, height: 1080 },
  carousel: { id: 'carousel', name: 'Carousel slide (9:16)', width: 1080, height: 1920, maxDurationSec: 5 }
}

/** Target encode settings derived from capabilities at export time. */
export interface ExportRequest {
  projectId: string
  preset: PresetId
  /** For carousel slides: the [start,end] range within the timeline to export. */
  rangeSec?: [number, number]
  /** Prefer NVENC when available; falls back to libx264. */
  preferNvenc: boolean
}
