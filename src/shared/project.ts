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

/** Per-clip color correction. Neutral = brightness 0, contrast 1, saturation 1. */
export interface ColorAdjust {
  brightness: number // -1..1
  contrast: number // 0..2
  saturation: number // 0..2
}

export const NEUTRAL_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 }

export function isNeutralColor(c: ColorAdjust | null | undefined): boolean {
  return !c || (c.brightness === 0 && c.contrast === 1 && c.saturation === 1)
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
  /** Optional color correction (absent = none). */
  color?: ColorAdjust
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

/** An image (logo, sticker, graphic) composited over the video for a time span. */
export interface ImageOverlay {
  id: string
  mediaId: string
  startSec: number
  endSec: number
  /** Position in logical 1080x1920 px (meaning depends on anchor). */
  x: number
  y: number
  /** Rendered size in logical px (aspect kept by the UI). */
  w: number
  h: number
  anchor: OverlayAnchor
  /** 0..1 */
  opacity: number
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

export type AudioKind = 'music' | 'voice' | 'extracted' | 'audio'

/**
 * An independent audio clip on the audio track. Source is any media asset
 * (audio-only file, or a video asset whose audio we use — e.g. extracted from a
 * clip). Positioned freely on the timeline; trimmed within the source.
 */
export interface AudioClip {
  id: string
  mediaId: string
  /** Position on the timeline (seconds). */
  startSec: number
  /** Trim within the source. outSec <= 0 means "to the end of the source". */
  inSec: number
  outSec: number
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
  /** Duck under dialogue/other audio on export (typical for a music bed). */
  duck: boolean
  /** Apply FFT noise reduction on export. */
  denoise?: boolean
  kind: AudioKind
}

/** A storyboard/script line, optionally pinned to a timeline time. */
export interface ScriptLine {
  id: string
  text: string
  /** Timeline position this line is linked to (null = unpinned). */
  atSec: number | null
}

export interface Project {
  id: string
  name: string
  /** Schema version for forward-compatible migrations. */
  version: number
  preset: PresetId
  clips: Clip[]
  overlays: TextOverlay[]
  imageOverlays: ImageOverlay[]
  captions: CaptionsConfig
  audioClips: AudioClip[]
  script: ScriptLine[]
  /**
   * Ids of the media assets that belong to this project (the library panel).
   * The asset *records* live globally on disk (so the same clip imported into
   * two projects isn't duplicated); this list scopes which of them this project
   * shows. Import order, deduped.
   */
  mediaIds: string[]
  createdAt: string
  updatedAt: string
}

/** Every media id this project references through its clips/overlays/audio. */
export function referencedMediaIds(p: Pick<Project, 'clips' | 'imageOverlays' | 'audioClips'>): string[] {
  const ids = [
    ...p.clips.map((c) => c.mediaId),
    ...p.imageOverlays.map((o) => o.mediaId),
    ...p.audioClips.map((a) => a.mediaId)
  ]
  return [...new Set(ids)]
}

/** Effective source out-point (outSec<=0 means "to the source end"). */
export function effectiveOut(c: AudioClip, sourceDurationSec: number): number {
  return c.outSec > 0 ? Math.min(c.outSec, sourceDurationSec) : sourceDurationSec
}

/** Timeline end of an audio clip, given its source duration. */
export function audioClipEnd(c: AudioClip, sourceDurationSec: number): number {
  return c.startSec + Math.max(0, effectiveOut(c, sourceDurationSec) - c.inSec)
}

export function createEmptyProject(id: string, name: string): Project {
  const now = new Date().toISOString()
  return {
    id,
    name,
    version: 3,
    preset: 'reel',
    clips: [],
    overlays: [],
    imageOverlays: [],
    captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, segments: [] },
    audioClips: [],
    script: [],
    mediaIds: [],
    createdAt: now,
    updatedAt: now
  }
}

/**
 * Bring an on-disk project up to the current shape. Notably migrates the old
 * single `music` bed (v1) into an audio clip on the new audio track (v2).
 */
export function migrateProject(raw: unknown): Project {
  const p = { ...(raw as Record<string, unknown>) } as Record<string, unknown> & Partial<Project>
  if (!Array.isArray(p.audioClips)) {
    const clips: AudioClip[] = []
    const music = (raw as { music?: Record<string, unknown> }).music
    if (music && typeof music.mediaId === 'string') {
      clips.push({
        id: 'music-0',
        mediaId: music.mediaId,
        startSec: 0,
        inSec: 0,
        outSec: 0, // whole source
        gainDb: typeof music.volumeDb === 'number' ? music.volumeDb : -14,
        fadeInSec: 0,
        fadeOutSec: typeof music.fadeOutSec === 'number' ? music.fadeOutSec : 0,
        duck: music.duck !== false,
        kind: 'music'
      })
    }
    p.audioClips = clips
  }
  delete (p as { music?: unknown }).music
  if (!Array.isArray(p.overlays)) p.overlays = []
  if (!Array.isArray(p.imageOverlays)) p.imageOverlays = []
  if (!Array.isArray(p.clips)) p.clips = []
  if (!Array.isArray(p.script)) p.script = []
  // Projects saved before the library was project-scoped have no mediaIds; seed
  // the list from whatever media they already reference so their library isn't
  // empty on open. (Audio-only/extra imports that were never placed are lost to
  // this best-effort backfill, which is acceptable for pre-scoping files.)
  if (!Array.isArray(p.mediaIds)) p.mediaIds = referencedMediaIds(p as Project)
  return p as Project
}
