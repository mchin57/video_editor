/**
 * The project document. Persisted as JSON. All spatial coordinates are in the
 * LOGICAL 1080x1920 output space, which is also the preview stage size and the
 * ASS PlayRes — so the same numbers drive preview and export by construction.
 */

import type { PresetId } from './export'

export interface CropRect {
  /** Source-pixel crop rectangle, aspect-locked to the output preset. */
  x: number
  y: number
  w: number
  h: number
}

export interface Clip {
  id: string
  mediaId: string
  /** Trim points in source time (seconds), after rotation is applied. */
  inSec: number
  outSec: number
  crop: CropRect | null
  mute: boolean
  gainDb: number
}

export type OverlayAnchor = 'center' | 'topLeft'

export interface PillStyle {
  enabled: boolean
  /** 8-digit hex with alpha, e.g. #000000CC. */
  color: string
  padPx: number
}

export interface TextOverlay {
  id: string
  text: string
  startSec: number
  endSec: number
  /** Position in logical 1080x1920 px. */
  x: number
  y: number
  anchor: OverlayAnchor
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
}

export interface CaptionWord {
  text: string
  startSec: number
  endSec: number
}

export interface CaptionSegment {
  id: string
  startSec: number
  endSec: number
  text: string
  words: CaptionWord[]
  enabled: boolean
}

export interface CaptionsConfig {
  enabled: boolean
  stylePreset: string
  /** Baseline Y in logical px; sits just above the bottom safe zone. */
  yBaseline: number
  segments: CaptionSegment[]
}

export interface MusicConfig {
  mediaId: string | null
  volumeDb: number
  /** Lower the music under spoken/clip audio (sidechain) on export. */
  duck: boolean
  fadeOutSec: number
  /** Mute the clips' original audio so only music plays. */
  muteVideo: boolean
}

export interface Project {
  id: string
  name: string
  /** Schema version for forward-compatible migrations. */
  version: number
  preset: PresetId
  clips: Clip[]
  overlays: TextOverlay[]
  captions: CaptionsConfig
  music: MusicConfig
  createdAt: string
  updatedAt: string
}

export function createEmptyProject(id: string, name: string): Project {
  const now = new Date().toISOString()
  return {
    id,
    name,
    version: 1,
    preset: 'reel',
    clips: [],
    overlays: [],
    captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, segments: [] },
    music: { mediaId: null, volumeDb: -14, duck: true, fadeOutSec: 1.5, muteVideo: false },
    createdAt: now,
    updatedAt: now
  }
}
