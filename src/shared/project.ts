/**
 * The project document. Persisted as JSON. All spatial coordinates are in the
 * LOGICAL 1080x1920 output space, which is also the preview stage size and the
 * ASS PlayRes — so the same numbers drive preview and export by construction.
 *
 * Visuals are a single, type-agnostic LAYER STACK (`layers`): every visible
 * element — video, image, text, and whatever gets added later — is a `Layer`
 * with a generic `content` payload, an absolute timeline window, a spatial
 * transform (move + zoom), and a visibility flag. Stacking is array order:
 * index 0 is the BACKGROUND (bottom); the last item is the front. Several layers
 * can be on screen at once (true compositing), so the timeline is ABSOLUTE time
 * rather than a sequence of clips.
 *
 * Audio (`audioClips`) and auto-generated `captions` are NOT visual layers; they
 * stay on their own tracks.
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

export interface PillStyle {
  enabled: boolean
  /** 8-digit hex with alpha, e.g. #000000CC. */
  color: string
  padPx: number
}

// --- Layer content (the polymorphic payload a layer carries) ----------------

/** A trimmed slice of a video source, composited as a layer. */
export interface VideoContent {
  kind: 'video'
  mediaId: string
  /** Trim points in source time (seconds), after rotation is applied. */
  inSec: number
  outSec: number
  mute: boolean
  gainDb: number
  /** Optional source-pixel crop (absent/null = full frame). */
  crop?: CropRect | null
  /** Optional color correction (absent = none). */
  color?: ColorAdjust
}

/** A still image (logo, photo, sticker, graphic) composited as a layer. */
export interface ImageContent {
  kind: 'image'
  mediaId: string
  /** 0..1 */
  opacity: number
}

/** A text element composited as a layer. */
export interface TextContent {
  kind: 'text'
  text: string
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
}

export type LayerContent = VideoContent | ImageContent | TextContent
export type LayerKind = LayerContent['kind']

/**
 * A single composited element. Spatially: `x`/`y` are the CENTER of the layer in
 * logical 1080x1920 px and `scale` is a uniform zoom (1 = natural — a media
 * layer fills the frame letterboxed, text renders at its font size). Temporally:
 * the layer is on screen during `[startSec, endSec)`. Anything outside the frame
 * is cropped by the stage; nothing renders behind the bottom (background) layer.
 */
export interface Layer {
  id: string
  /** Optional user-facing name (falls back to a content-derived label). */
  name?: string
  hidden: boolean
  startSec: number
  endSec: number
  /** Center position in logical px. */
  x: number
  y: number
  /** Uniform zoom (1 = natural size). */
  scale: number
  content: LayerContent
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
  /** The visual stack, back (index 0 = background) → front (last). */
  layers: Layer[]
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

/** Every media id this project references through its layers/audio. */
export function referencedMediaIds(p: Pick<Project, 'layers' | 'audioClips'>): string[] {
  const ids: string[] = []
  for (const l of p.layers) {
    if (l.content.kind === 'video' || l.content.kind === 'image') ids.push(l.content.mediaId)
  }
  for (const a of p.audioClips) ids.push(a.mediaId)
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
    version: 4,
    preset: 'reel',
    layers: [],
    captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, segments: [] },
    audioClips: [],
    script: [],
    mediaIds: [],
    createdAt: now,
    updatedAt: now
  }
}

// --- Migration --------------------------------------------------------------

const FRAME = { w: 1080, h: 1920 } as const

// Old (pre-v4) shapes, read defensively from raw JSON for migration only.
interface OldClip {
  id?: string
  mediaId: string
  inSec: number
  outSec: number
  crop?: CropRect | null
  mute?: boolean
  gainDb?: number
  color?: ColorAdjust
}
interface OldOverlay {
  id?: string
  text: string
  startSec: number
  endSec: number
  x: number
  y: number
  anchor?: 'center' | 'topLeft'
  fontFamily?: string
  fontSizePx?: number
  color?: string
  pill?: PillStyle
  z?: number
  hidden?: boolean
}
interface OldImageOverlay {
  id?: string
  mediaId: string
  startSec: number
  endSec: number
  x: number
  y: number
  w: number
  h: number
  anchor?: 'center' | 'topLeft'
  opacity?: number
  z?: number
  hidden?: boolean
}

let migrateCounter = 0
const fallbackId = (): string => `mig-${Date.now().toString(36)}-${migrateCounter++}`

/** Scale for an old image overlay's display width within the frame-contain box. */
function imageScaleFromBox(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0.5
  const frameAspect = FRAME.w / FRAME.h
  // contain: wide-of-frame images fill width (1080); tall ones fill height (1920).
  return w / h >= frameAspect ? w / FRAME.w : h / FRAME.h
}

/** Build the layer stack from the legacy clips/overlays/imageOverlays arrays. */
function migrateLayers(raw: Record<string, unknown>): Layer[] {
  const layers: Layer[] = []

  // Video clips were a SEQUENCE — lay them out back-to-back in absolute time so
  // existing reels still play the same. They sit at the back, in order.
  const clips = Array.isArray(raw.clips) ? (raw.clips as OldClip[]) : []
  let acc = 0
  for (const c of clips) {
    const dur = Math.max(0.01, c.outSec - c.inSec)
    layers.push({
      id: c.id ?? fallbackId(),
      hidden: false,
      startSec: acc,
      endSec: acc + dur,
      x: FRAME.w / 2,
      y: FRAME.h / 2,
      scale: 1,
      content: {
        kind: 'video',
        mediaId: c.mediaId,
        inSec: c.inSec,
        outSec: c.outSec,
        mute: c.mute ?? false,
        gainDb: c.gainDb ?? 0,
        crop: c.crop ?? null,
        ...(c.color ? { color: c.color } : {})
      }
    })
    acc += dur
  }

  // Images sat above video, below text (old fixed z-order). Preserve that.
  const images = Array.isArray(raw.imageOverlays) ? (raw.imageOverlays as OldImageOverlay[]) : []
  for (const o of images) {
    const cx = o.anchor === 'topLeft' ? o.x + o.w / 2 : o.x
    const cy = o.anchor === 'topLeft' ? o.y + o.h / 2 : o.y
    layers.push({
      id: o.id ?? fallbackId(),
      hidden: !!o.hidden,
      startSec: o.startSec,
      endSec: o.endSec,
      x: cx,
      y: cy,
      scale: imageScaleFromBox(o.w, o.h),
      content: { kind: 'image', mediaId: o.mediaId, opacity: o.opacity ?? 1 }
    })
  }

  // Text on top.
  const overlays = Array.isArray(raw.overlays) ? (raw.overlays as OldOverlay[]) : []
  for (const o of overlays) {
    layers.push({
      id: o.id ?? fallbackId(),
      hidden: !!o.hidden,
      startSec: o.startSec,
      endSec: o.endSec,
      x: o.x,
      y: o.y,
      scale: 1,
      content: {
        kind: 'text',
        text: o.text,
        fontFamily: o.fontFamily ?? 'Inter, system-ui, sans-serif',
        fontSizePx: o.fontSizePx ?? 76,
        color: o.color ?? '#ffffff',
        pill: o.pill ?? { enabled: true, color: '#000000cc', padPx: 18 }
      }
    })
  }

  return layers
}

/**
 * Bring an on-disk project up to the current shape. Migrates the old single
 * `music` bed (v1) into an audio clip, and the old separate clips/overlays/
 * imageOverlays arrays (≤v3) into the unified `layers` stack (v4).
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

  // Build the unified layer stack from legacy arrays if it isn't present yet.
  if (!Array.isArray(p.layers)) {
    p.layers = migrateLayers(raw as Record<string, unknown>)
  }
  // Drop the legacy visual arrays once folded into `layers`.
  delete (p as Record<string, unknown>).clips
  delete (p as Record<string, unknown>).overlays
  delete (p as Record<string, unknown>).imageOverlays

  if (!Array.isArray(p.script)) p.script = []
  if (typeof p.version !== 'number' || p.version < 4) p.version = 4
  // Projects saved before the library was project-scoped have no mediaIds; seed
  // the list from whatever media they already reference so their library isn't
  // empty on open.
  if (!Array.isArray(p.mediaIds)) p.mediaIds = referencedMediaIds(p as Project)
  return p as Project
}
