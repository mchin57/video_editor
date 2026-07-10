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
import { DEFAULT_FONT_ID, isKnownFont } from './fonts'
import { FRAME } from './layers'
import type { TextAnimation } from './textAnim'

export interface CropRect {
  /** Source-pixel crop rectangle, aspect-locked to the output preset. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * A crop expressed as 0..1 fractions of the element it applies to (rather than
 * source pixels). Used for image layers, where the on-disk display PNG is capped
 * at 1920px so a pixel rect would be ambiguous; fractions stay correct in preview
 * (via naturalWidth/Height) and export (via ffmpeg `iw`/`ih`).
 */
export interface NormCrop {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A held ("frozen") frame inside a video layer: at source second `atSec`, the
 * frame is held for `holdSec`, stretching the layer's played duration by that
 * much. Stored sorted by `atSec`.
 */
export interface FreezeHold {
  atSec: number
  holdSec: number
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

/**
 * Per-clip motion stabilization (ffmpeg vidstab two-pass, applied on export).
 * Absent/null on a video layer = off. `shakiness` tunes the detector (how much
 * camera shake to expect); `smoothing` is the half-window in frames the
 * transform pass averages the camera path over — higher is steadier but crops
 * and zooms in more to hide the corrected edges.
 */
export interface Stabilize {
  shakiness: number // 1 (subtle) .. 10 (very shaky)
  smoothing: number // frames; higher = smoother but more crop
}

export const DEFAULT_STABILIZE: Stabilize = { shakiness: 5, smoothing: 15 }

export interface PillStyle {
  enabled: boolean
  /** 8-digit hex with alpha, e.g. #000000CC. */
  color: string
  padPx: number
}

/** Corner radius (logical px) for the pill behind text, scaled to its padding so
 *  a roomier pill reads as rounder. The single source of truth for both the
 *  CSS-scaled preview (`PreviewStage`) and the export rasteriser (`textImage`),
 *  which must agree on the shape. */
export function pillRadiusPx(padPx: number): number {
  return Math.round(padPx * 0.6)
}

// --- Shared text decoration (used by BOTH text overlays and captions) -------

/**
 * Glyph outline. Burns via libass `\bord`/`\3c` (BorderStyle 1). Mutually
 * exclusive with a pill (BorderStyle 3 repurposes the same tags for the box), so
 * stroke is only applied when `pill.enabled` is false.
 */
export interface StrokeStyle {
  /** Outline width in logical px (0 = none). */
  widthPx: number
  color: string
}

/**
 * Drop shadow. Burns via libass `\shad` (a single diagonal offset; no
 * independent x/y) + `\4c` (colour) + `\blur` (softness). Preview uses CSS
 * `text-shadow`, clamped to a diagonal offset so it matches the burn.
 */
export interface ShadowStyle {
  /** Diagonal offset distance in logical px (0 = none). */
  distancePx: number
  color: string
  /** Edge softness (libass `\blur`); 0 = crisp. */
  blur: number
}

/**
 * 2-stop linear gradient fill. When present it OVERRIDES the flat `color`.
 * Preview uses `background-clip: text`; export renders the text to a transparent
 * PNG and composites it (ASS has no gradients).
 */
export interface GradientStyle {
  from: string
  to: string
  /** Gradient angle in degrees (0 = →, 90 = ↓, CSS convention). */
  angle: number
}

export const DEFAULT_STROKE: StrokeStyle = { widthPx: 8, color: '#000000' }
export const DEFAULT_SHADOW: ShadowStyle = { distancePx: 2, color: '#000000d9', blur: 0 }
export const DEFAULT_GRADIENT: GradientStyle = { from: '#FF512F', to: '#DD2476', angle: 90 }

/**
 * The visual styling shared by a text overlay (`TextContent`) and a caption
 * (`CaptionStyle`): the bundled font, the fill (flat `color` or a `gradient` that
 * overrides it), and the optional decorations (pill / stroke / shadow). Both
 * extend this so the font picker, the shared `TextStyleControls`, the preview, and
 * the export all drive off one shape and stay in lockstep. @see docs/SHARED.md
 */
export interface TextStyleBase {
  /** Bundled-font id (see `shared/fonts.ts`); resolved for preview + export. */
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
  /** Glyph outline (absent/null = none). Ignored when `pill.enabled`. */
  stroke?: StrokeStyle | null
  /** Drop shadow (absent/null = none). */
  shadow?: ShadowStyle | null
  /** Gradient fill; overrides `color` when present (absent/null = flat color). */
  gradient?: GradientStyle | null
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
  /**
   * Per-clip override of the project-wide stabilization default
   * (`Project.stabilizeDefault`). `undefined` = inherit the default; `null` =
   * force stabilization OFF for this clip; a `Stabilize` object = force it ON
   * with these settings. The last two flag the clip as exempt from the default
   * (surfacing an indicator on its timeline block). See `effectiveStabilize`.
   */
  stabilize?: Stabilize | null
  /** Source-time freeze holds (absent/empty = none). Kept sorted by `atSec`. */
  freezes?: FreezeHold[]
  /**
   * Constant playback speed (absent = 1). 0.5 = half speed (slow-mo, the clip
   * takes twice as long on the timeline), 2 = double. Freeze holds stay
   * wall-clock (a 2s hold is 2s at any speed). All timeline↔source math goes
   * through `videoSpeed`/`videoSourceTime`/`playedVideoDuration`
   * (`shared/layers.ts`) — never divide by this inline.
   */
  speed?: number
}

/** Allowed constant-speed range (matches the Inspector control). */
export const MIN_VIDEO_SPEED = 0.25
export const MAX_VIDEO_SPEED = 4

/** A video clip's effective speed: its `speed`, clamped, defaulting to 1. */
export function videoSpeed(c: Pick<VideoContent, 'speed'>): number {
  const s = c.speed
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return 1
  return Math.min(MAX_VIDEO_SPEED, Math.max(MIN_VIDEO_SPEED, s))
}

/** A still image (logo, photo, sticker, graphic) composited as a layer. */
export interface ImageContent {
  kind: 'image'
  mediaId: string
  /** 0..1 */
  opacity: number
  /** Optional crop in 0..1 fractions of the source image (absent/null = full). */
  crop?: NormCrop | null
  /** 90° clockwise rotation steps (0..3). Absent = 0. */
  rotateQuarters?: number
  /** Mirror horizontally / vertically. Absent = false. */
  flipH?: boolean
  flipV?: boolean
}

/** A text element composited as a layer. */
export interface TextContent extends TextStyleBase {
  kind: 'text'
  text: string
  /** Explicit wrap-box width in logical px. Absent = auto (hug the text). Set
   *  when the user drags a side resize handle; text re-wraps within it. */
  widthPx?: number
  /** Entrance/exit animation (absent/null = static). Not honored while the
   *  overlay burns as a rasterised PNG (gradient / explicit wrap width) — see
   *  `effectiveTextAnimation` (shared/textAnim.ts), which both preview and
   *  export resolve through. */
  animation?: TextAnimation | null
}

export type LayerContent = VideoContent | ImageContent | TextContent
export type LayerKind = LayerContent['kind']

/**
 * One keyframe of a layer's animatable transform. `tSec` is relative to the
 * layer's `startSec` (so moving the block on the timeline keeps the motion);
 * values are the same units as the layer's base `x`/`y`/`scale`. Kept sorted
 * by `tSec`. Interpolation is LINEAR between keyframes and holds outside the
 * first/last — both sides resolve through `layerTransformAt`
 * (`shared/layers.ts`); never lerp inline.
 */
export interface LayerKeyframe {
  tSec: number
  x: number
  y: number
  scale: number
}

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
  /** Uniform zoom (1 = natural size). Corner resize handles adjust this. */
  scale: number
  /** Non-uniform box multipliers on top of `scale` (default 1). Media edge
   *  handles set these to stretch/squeeze one dimension (distortion). Reserved
   *  for a future text free-distort mode; text ignores them today. */
  stretchX?: number
  stretchY?: number
  /**
   * Position/scale keyframes (absent/empty = static base transform). Honored
   * for video and image layers by preview and export (`layerTransformAt`);
   * text layers ignore them (they animate via `TextContent.animation`).
   */
  keyframes?: LayerKeyframe[]
  content: LayerContent
}

export interface CaptionWord {
  text: string
  startSec: number
  endSec: number
}

/**
 * Visual style for a caption — the same knobs a text layer has, so captions can
 * be coloured, repositioned, sized and rotated. Position is the CENTER in logical
 * 1080x1920 px (matching layers). Used both as the lane-wide default
 * (`CaptionsConfig.style`) and as a per-segment override (`CaptionSegment.style`).
 */
export interface CaptionStyle extends TextStyleBase {
  /** Center position in logical px. */
  x: number
  y: number
  /** Clockwise rotation in degrees (0 = upright). */
  rotationDeg: number
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  x: 540,
  y: 1340,
  fontFamily: DEFAULT_FONT_ID,
  fontSizePx: 64,
  color: '#ffffff',
  rotationDeg: 0,
  pill: { enabled: false, color: '#000000cc', padPx: 18 }
}

export interface CaptionSegment {
  id: string
  startSec: number
  endSec: number
  text: string
  words: CaptionWord[]
  enabled: boolean
  /** Per-segment style override. When set, this block is exempt from the lane-wide
   *  caption style and uses this instead; absent/null = follow the global style. */
  style?: CaptionStyle | null
}

export interface CaptionsConfig {
  enabled: boolean
  stylePreset: string
  /** Baseline Y in logical px; sits just above the bottom safe zone. Legacy seed
   *  for `style.y`; the lane-wide `style` is now the source of truth. */
  yBaseline: number
  /** Lane-wide caption style (the default for every segment without an override). */
  style: CaptionStyle
  segments: CaptionSegment[]
}

/** The style actually used to render a caption: its override, else the lane style. */
export function effectiveCaptionStyle(captions: CaptionsConfig, seg: CaptionSegment): CaptionStyle {
  return seg.style ?? captions.style
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
  /**
   * Per-clip override of the project-wide noise filter (`Project.denoiseDefault`).
   * `undefined` = inherit the project default; `true`/`false` = force the FFT
   * noise reduction on/off for this clip (and flag it as exempt from the default,
   * which surfaces a small indicator on its timeline block). See
   * `effectiveDenoise`.
   */
  denoise?: boolean
  /** Skip this clip when captioning the audio lane (e.g. a music bed). */
  excludeFromCaptions?: boolean
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
  /**
   * Project-wide default for the audio noise filter (FFT denoise on export).
   * Off by default. Individual clips can override it via `AudioClip.denoise`.
   */
  denoiseDefault: boolean
  /**
   * Project-wide default for motion stabilization. `null` = off (the default);
   * a `Stabilize` object = stabilize every video clip with these settings.
   * Individual clips can override it via `VideoContent.stabilize`.
   */
  stabilizeDefault: Stabilize | null
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

/**
 * The shared tri-state override mechanism for a per-clip setting that can inherit
 * a project-wide default: `undefined` inherits `projectDefault`; any other value
 * (including `null`) is an explicit override. Used by denoise and stabilize today;
 * reuse it for any future inherit / force-on / force-off knob. @see docs/SHARED.md
 */
export function resolveOverride<T>(value: T | undefined, projectDefault: T): T {
  return value === undefined ? projectDefault : value
}

/** Whether a tri-state override is set (i.e. not inheriting the project default). */
export function isOverridden(value: unknown): boolean {
  return value !== undefined
}

/** Whether the noise filter actually runs for this clip on export (clip override
 *  wins, else the project-wide default). */
export function effectiveDenoise(c: Pick<AudioClip, 'denoise'>, denoiseDefault: boolean): boolean {
  return resolveOverride(c.denoise, denoiseDefault)
}

/** Whether a clip overrides the project noise-filter default (gets an indicator). */
export function denoiseOverridden(c: Pick<AudioClip, 'denoise'>): boolean {
  return isOverridden(c.denoise)
}

/** The stabilization actually applied to a video clip on export (clip override
 *  wins, else the project-wide default). `null` = no stabilization. */
export function effectiveStabilize(
  c: Pick<VideoContent, 'stabilize'>,
  stabilizeDefault: Stabilize | null
): Stabilize | null {
  return resolveOverride(c.stabilize, stabilizeDefault)
}

/** Whether a clip overrides the project stabilization default (gets an indicator). */
export function stabilizeOverridden(c: Pick<VideoContent, 'stabilize'>): boolean {
  return isOverridden(c.stabilize)
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
    version: 12,
    preset: 'reel',
    layers: [],
    captions: {
      enabled: false,
      stylePreset: 'reels-bold',
      yBaseline: 1340,
      style: { ...DEFAULT_CAPTION_STYLE },
      segments: []
    },
    audioClips: [],
    denoiseDefault: false,
    stabilizeDefault: null,
    script: [],
    mediaIds: [],
    createdAt: now,
    updatedAt: now
  }
}

// --- Migration --------------------------------------------------------------

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
  const frameAspect = FRAME.width / FRAME.height
  // contain: wide-of-frame images fill width (1080); tall ones fill height (1920).
  return w / h >= frameAspect ? w / FRAME.width : h / FRAME.height
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
      x: FRAME.width / 2,
      y: FRAME.height / 2,
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
        fontFamily: isKnownFont(o.fontFamily) ? o.fontFamily! : DEFAULT_FONT_ID,
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
  // Captions gained a lane-wide visual `style` (v6). Older projects only had a
  // `yBaseline`; seed the style from it so they keep their bottom-baseline look.
  if (p.captions && !p.captions.style) {
    const yBaseline = typeof p.captions.yBaseline === 'number' ? p.captions.yBaseline : DEFAULT_CAPTION_STYLE.y
    p.captions.style = { ...DEFAULT_CAPTION_STYLE, y: yBaseline }
  }
  // v7: `fontFamily` now stores a bundled-font id (shared/fonts.ts), not a CSS
  // stack. Normalise any legacy/unknown value to a known id across text layers,
  // the lane-wide caption style, and per-segment overrides. New optional
  // decoration fields (stroke/shadow/gradient) are absence-tolerant.
  const normFont = (id: unknown): string =>
    typeof id === 'string' && isKnownFont(id) ? id : DEFAULT_FONT_ID
  if (Array.isArray(p.layers)) {
    for (const l of p.layers) {
      if (l.content.kind === 'text') l.content.fontFamily = normFont(l.content.fontFamily)
    }
  }
  if (p.captions) {
    if (p.captions.style) p.captions.style.fontFamily = normFont(p.captions.style.fontFamily)
    for (const s of p.captions.segments ?? []) {
      if (s.style) s.style.fontFamily = normFont(s.style.fontFamily)
    }
  }
  // v8: project-wide noise-filter default + tri-state per-clip override. Before
  // v8 the default was effectively off, so a legacy explicit `denoise:false` was
  // redundant with the default — normalise it to `undefined` (inherit) so old
  // projects don't sprout spurious "noise off" indicators. `denoise:true` stays
  // an explicit override. `stabilize` is a new absence-tolerant optional field.
  if (typeof p.denoiseDefault !== 'boolean') p.denoiseDefault = false
  if ((p.version ?? 0) < 8 && Array.isArray(p.audioClips)) {
    for (const a of p.audioClips) if (a.denoise === false) a.denoise = undefined
  }
  // Stabilization shares the noise-filter shape: a project-wide default plus a
  // tri-state per-clip override (`undefined` inherit / `null` off / object on).
  // Off by default; per-clip `stabilize` is absence-tolerant.
  if (p.stabilizeDefault === undefined) p.stabilizeDefault = null
  // v5/v6 only add absence-tolerant optional fields (freezes, image crop/rotate/
  // flip, caption style); v7 normalises font ids above. v9 adds absence-tolerant
  // resize geometry (layer `stretchX`/`stretchY`, text `widthPx`) — read sites
  // default `stretch` to 1 and `widthPx` to auto, so no data transform is needed.
  // v10 adds absence-tolerant text `animation` (absent = static, no transform).
  // v11 adds absence-tolerant video `speed` (absent = 1, no transform).
  // v12 adds absence-tolerant layer `keyframes` (absent = static, no transform).
  if (typeof p.version !== 'number' || p.version < 12) p.version = 12
  // Projects saved before the library was project-scoped have no mediaIds; seed
  // the list from whatever media they already reference so their library isn't
  // empty on open.
  if (!Array.isArray(p.mediaIds)) p.mediaIds = referencedMediaIds(p as Project)
  return p as Project
}
