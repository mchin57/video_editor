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

import { DEFAULT_PRESET_ID, isPresetId, type PresetId } from './formats'
import { DEFAULT_FONT_ID, isKnownFont } from './fonts'
import { FRAME } from './layers'
import type { AudioFx } from './audioFx'
import type { GraphicMark } from './graphics'
import type { PoseSettings } from './pose'
import type { TextEffects } from './sparkle'
import type { TextAnimation } from './textAnim'

export interface CropRect {
  /** Source-pixel crop rectangle, aspect-locked to the output preset. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * Which array a timeline tile lives in. Ids are only unique within their own
 * array, so anything that treats the timeline as ONE surface (selection, link
 * groups) has to carry the kind alongside the id.
 */
export type TimelineItemKind = 'layer' | 'caption' | 'audio'

/**
 * A reference to one timeline tile — the unit of selection and of link groups.
 * The tile types themselves stay in their own arrays (`layers` /
 * `captions.segments` / `audioClips`); this is the common handle the timeline
 * uses to move, split, delete and link them uniformly. Group logic lives in
 * `renderer/lib/links.ts`.
 */
export interface TimelineItemRef {
  kind: TimelineItemKind
  id: string
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

/**
 * One keyframe of a video clip's speed ramp, anchored in SOURCE time (like
 * freeze holds, so trims/splits keep the ramp attached to the footage). Speed
 * is piecewise-linear between keyframes and holds flat outside the first/last.
 * Kept sorted by `atSec`. All timeline↔source math goes through
 * `shared/speed.ts` (`playedBetween`/`sourceAfterPlayed`) — never integrate
 * inline.
 */
export interface SpeedKeyframe {
  atSec: number
  speed: number
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
  /** Mirror horizontally / vertically (absent = false), applied to the picture
   *  after the crop — like `ImageContent`'s flips. */
  flipH?: boolean
  flipV?: boolean
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
  /**
   * Keyframed speed ramp (absent/empty = the constant `speed` applies). When
   * non-empty it OVERRIDES `speed`: playback speed is piecewise-linear between
   * the keyframes (source-time anchored). The clip's own audio is dropped
   * while a ramp is active (no variable-tempo audio path — preview and export
   * agree by both muting).
   */
  speedRamp?: SpeedKeyframe[]
  /**
   * The body-pose overlay drawn on this clip (absent/null = none): which
   * detected people show, their colours and the joint angles labelled. The
   * keypoints themselves are per MEDIA file, saved in the project folder and
   * looked up in source time, so a trim, split, freeze or speed change keeps
   * the skeleton on the athlete. @see shared/pose.ts
   */
  pose?: PoseSettings | null
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
   *  overlay burns as a rasterised PNG (gradient / explicit wrap width / colour
   *  emoji) — see
   *  `effectiveTextAnimation` (shared/textAnim.ts), which both preview and
   *  export resolve through. */
  animation?: TextAnimation | null
  /**
   * Decorative effects layered ON TOP of the glyphs, independent of the
   * entrance/exit animation — so any entrance can be combined with any effect.
   * Absent/null = none. Unlike `animation`, these DO survive the rasterised-PNG
   * path: sparkles burn as their own ASS events above the image.
   * @see shared/sparkle.ts
   */
  effects?: TextEffects | null
}

/** A cell rectangle in the LOGICAL 1080×1920 space (top-left + size). */
export interface CellRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One cell of a multi-clip layout: a media slot with its own source trim,
 * filling `rect` aspect-FILL (center cover-crop — preview `object-fit: cover`
 * and the export's `coverCrop` must agree). `mediaId: null` = empty cell
 * (lower layers show through). Cells play at 1× from the layout's `startSec`.
 */
export interface LayoutCell {
  mediaId: string | null
  inSec: number
  outSec: number
  mute: boolean
  rect: CellRect
  /**
   * Nested composition filling this cell instead of a single clip. When present
   * it OVERRIDES `mediaId`: the panel is a whole sub-timeline (own layers /
   * audio / captions) edited with the same editor and pre-rendered on export.
   * Plays from its local t=0 for `compositionDuration` seconds (no in/out trim
   * on comps in v1). Traverse via `shared/compositions.ts` — never walk inline.
   */
  comp?: Composition | null
}

/**
 * A multi-clip layout (split screen / panels) composited as ONE layer: N cells,
 * each showing a trimmed clip in a rect of the logical space. `presetId` names
 * the built-in arrangement the rects came from (`shared/layouts.ts`); the rects
 * themselves are stored so a future custom-layout editor can reshape them. The
 * layer's own x/y/scale move/zoom the whole arrangement (cell rects resolve
 * through `layoutCellRect`); layer keyframes are NOT honored for layouts.
 */
export interface LayoutContent {
  kind: 'layout'
  presetId: string
  cells: LayoutCell[]
}

/**
 * A COMPOUND CLIP: a nested composition composited as one full-frame layer.
 * The comp plays from its local t=0 at the layer's `startSec` (no in/out trim
 * on comps in v1 — the layer window `[startSec, endSec)` gates visibility, with
 * `endSec` maintained as `startSec + compositionDuration(comp)` by the store
 * actions). Like layouts, compound layers ignore transform keyframes. Edited by
 * ENTERING it (the whole editor re-targets to the nested comp); exported by
 * pre-rendering it to an intermediate. Traverse via `shared/compositions.ts`.
 */
export interface CompoundContent {
  kind: 'compound'
  comp: Composition
}

/**
 * Shapes and telestrator marks (arrows, lines, rectangles, ellipses, angles)
 * drawn over the picture, each appearing at its own time inside the layer
 * window. Marks are in canonical px before the layer transform, which moves/
 * zooms the whole drawing (keyframes included). How a mark looks and reveals
 * is `shared/graphics.ts` — the preview and the export both draw from it.
 */
export interface GraphicsContent {
  kind: 'graphics'
  marks: GraphicMark[]
}

export type LayerContent = VideoContent | ImageContent | TextContent | LayoutContent | CompoundContent | GraphicsContent
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
  /** Layer opacity 0..1 at this keyframe (absent = 1). Multiplies an image
   *  layer's base `opacity`. Export drives it per-frame via sendcmd →
   *  `colorchannelmixer aa` (see FFMPEG-NOTES "Keyframed opacity"). */
  opacity?: number
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
   * Free-angle rotation, CLOCKWISE degrees about the box centre (absent = 0).
   * A layer transform like x/y/scale — applied to the whole sized box, after
   * any crop — so it never changes the box's shape or fit. Honored for video,
   * image and text layers (preview + export); layout, compound and graphics
   * layers ignore it (no rotate handle is offered on them). One model with
   * `CaptionStyle.rotationDeg`; all the math lives in `shared/rotation.ts`.
   */
  rotationDeg?: number
  /**
   * Position/scale keyframes (absent/empty = static base transform). Honored
   * for video, image and graphics layers by preview and export (`layerTransformAt`);
   * text layers ignore them (they animate via `TextContent.animation`).
   */
  keyframes?: LayerKeyframe[]
  /** Link group this tile belongs to (absent = unlinked). @see linkGroupId docs
   *  on `CaptionSegment`/`AudioClip` — one id space across all three arrays. */
  linkGroupId?: string
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
  pill: { enabled: false, color: '#000000ff', padPx: 18 }
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
  /**
   * LINK GROUP this tile belongs to (absent = unlinked). Tiles sharing an id
   * move, split and delete together and are always selected as a whole — see
   * `renderer/lib/links.ts`, the single home for that logic. The id space is
   * shared by `Layer`, `CaptionSegment` and `AudioClip` (a group typically spans
   * lanes, e.g. a clip + its extracted audio). Layout layers are never members.
   * A group with fewer than two surviving members is treated as unlinked and
   * pruned (`pruneLinkGroups`), so a dangling id can never change behavior.
   * Nothing downstream of the timeline reads this — export is unaffected.
   */
  linkGroupId?: string
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

export type AudioKind = 'music' | 'voice' | 'extracted' | 'audio' | 'fx'

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
  /**
   * Silence this clip without losing its level. Absent/false = audible.
   * Deliberately separate from `gainDb` so muting is reversible: dropping the
   * slider to -40 dB and back loses whatever you had set, and -40 dB is not
   * actually silent anyway.
   *
   * The two sides reach silence differently and that is fine — the preview
   * holds the clip at gain 0 (it still tracks the playhead, so unmuting mid-
   * playback is instant), while the export omits the clip from the mix
   * entirely rather than paying to decode a source that contributes nothing.
   */
  mute?: boolean
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
  /** Link group this tile belongs to (absent = unlinked). @see `CaptionSegment.linkGroupId`. */
  linkGroupId?: string
  /**
   * Set only on a GENERATED EFFECT TRACK (`kind: 'fx'`) — the wet signal of an
   * echo or chorus, rendered to its own asset and mixed over the untouched dry
   * clip. Records the settings and the source window it was rendered from, so
   * the Inspector can re-edit and re-render it. Absent on ordinary audio.
   *
   * Nothing downstream of the timeline reads this: an effect track exports as
   * an ordinary audio clip, which is exactly the point. @see shared/audioFx.ts
   */
  fx?: AudioFx | null
  /**
   * The project volume level this clip is matched to (`Project.volumeLevels`;
   * absent = none, the clip plays at its own `gainDb`). At most one. While set,
   * the level decides the clip's gain (`clipGain`, shared/volumeLevels.ts) and
   * `gainDb` is kept but unused — leaving the level restores it. Ignored on an
   * effect track (`kind: 'fx'`), which follows the clip it was made from.
   */
  volumeLevelId?: string
  kind: AudioKind
}

/**
 * A named loudness target audio clips can join (File ▸ Volume levels). Every
 * clip in a level is gained so its own stretch of audio lands on `targetLufs`
 * (shared/volumeLevels.ts), in the preview and the export alike.
 */
export interface VolumeLevel {
  id: string
  name: string
  /** Integrated loudness each member clip is matched to (LUFS). */
  targetLufs: number
}

/** The permanent level every project has: can't be deleted or renamed. */
export const DEFAULT_VOLUME_LEVEL_ID = 'default'
export const DEFAULT_VOLUME_LEVEL_NAME = 'Default'
/** Default's target, and the starting target of a new level (LUFS). */
export const DEFAULT_TARGET_LUFS = -16

export function defaultVolumeLevel(): VolumeLevel {
  return { id: DEFAULT_VOLUME_LEVEL_ID, name: DEFAULT_VOLUME_LEVEL_NAME, targetLufs: DEFAULT_TARGET_LUFS }
}

/**
 * A document's level list made well-formed: malformed entries and duplicate
 * ids dropped, Default present (first, named "Default") — its target is kept
 * when it was set. Returns the input array itself when nothing changes.
 */
export function normalizeVolumeLevels(raw: unknown): VolumeLevel[] {
  const list = Array.isArray(raw) ? (raw as unknown[]) : []
  const seen = new Set<string>()
  const out: VolumeLevel[] = []
  for (const x of list) {
    const l = x as Partial<VolumeLevel> | null
    if (!l || typeof l.id !== 'string' || !l.id || seen.has(l.id)) continue
    if (typeof l.targetLufs !== 'number' || !Number.isFinite(l.targetLufs)) continue
    seen.add(l.id)
    out.push(
      l.id === DEFAULT_VOLUME_LEVEL_ID
        ? { id: l.id, name: DEFAULT_VOLUME_LEVEL_NAME, targetLufs: l.targetLufs }
        : { id: l.id, name: typeof l.name === 'string' && l.name.trim() ? l.name : 'Level', targetLufs: l.targetLufs }
    )
  }
  const di = out.findIndex((l) => l.id === DEFAULT_VOLUME_LEVEL_ID)
  const def = di >= 0 ? out.splice(di, 1)[0] : defaultVolumeLevel()
  const result = [def, ...out]
  const same =
    Array.isArray(raw) &&
    raw.length === result.length &&
    result.every((l, i) => {
      const r = (raw as VolumeLevel[])[i]
      return r.id === l.id && r.name === l.name && r.targetLufs === l.targetLufs
    })
  return same ? (raw as VolumeLevel[]) : result
}

/** A storyboard/script line, optionally pinned to a timeline time. */
export interface ScriptLine {
  id: string
  text: string
  /** Timeline position this line is linked to (null = unpinned). */
  atSec: number | null
}

/**
 * The editable core of a timeline document: a visual layer stack + audio track
 * + captions. The top-level `Project` IS a Composition (plus file/identity
 * fields); a compound clip or a layout cell carries a nested one. Everything
 * that EDITS a timeline (store actions, `lib/links.ts` ops) or RENDERS one
 * (preview stack, exporter) should operate on a Composition, so the same code
 * serves the root document and any nested comp. Nesting is INLINE (a comp owns
 * its children by value), which makes reference cycles impossible by
 * construction — only a depth cap is enforced (`shared/compositions.ts`).
 */
export interface Composition {
  /** The visual stack, back (index 0 = background) → front (last). */
  layers: Layer[]
  captions: CaptionsConfig
  audioClips: AudioClip[]
}

export interface Project extends Composition {
  id: string
  name: string
  /** Schema version for forward-compatible migrations. */
  version: number
  preset: PresetId
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
   * Their records (paths to the originals + fingerprints) are main's in-memory
   * library, saved in the .reel beside the document (docs/MEDIA-POINTERS.md).
   * Import order, deduped.
   */
  mediaIds: string[]
  /**
   * Named loudness targets audio clips can join (`AudioClip.volumeLevelId`) —
   * root-only: a clip in a nested comp joins the project's levels. Always
   * holds Default first (`normalizeVolumeLevels`). Schema v26.
   */
  volumeLevels: VolumeLevel[]
  createdAt: string
  updatedAt: string
}

/** One place a document uses a media item: as what, and the furthest source
 *  second it plays (0 = unknown, e.g. an audio clip running "to the end"). */
export interface MediaUse {
  mediaId: string
  as: 'video' | 'image' | 'audio'
  outSec: number
}

/** Every use of media in this document — layers, layout cells and audio clips,
 *  RECURSING into nested compositions (compound layers and layout-cell comps).
 *  THE canonical media walker for nested comps — don't write a parallel one;
 *  `referencedMediaIds` is built on it. */
export function mediaUses(p: Pick<Project, 'layers' | 'audioClips'>): MediaUse[] {
  const uses: MediaUse[] = []
  for (const l of p.layers) {
    const c = l.content
    if (c.kind === 'video') uses.push({ mediaId: c.mediaId, as: 'video', outSec: Math.max(0, c.outSec) })
    if (c.kind === 'image') uses.push({ mediaId: c.mediaId, as: 'image', outSec: 0 })
    if (c.kind === 'layout') {
      for (const cell of c.cells) {
        if (cell.comp) uses.push(...mediaUses(cell.comp))
        else if (cell.mediaId) uses.push({ mediaId: cell.mediaId, as: 'video', outSec: Math.max(0, cell.outSec) })
      }
    }
    if (c.kind === 'compound') uses.push(...mediaUses(c.comp))
  }
  for (const a of p.audioClips) uses.push({ mediaId: a.mediaId, as: 'audio', outSec: Math.max(0, a.outSec) })
  return uses
}

/** Every media id this document references through its layers/audio, RECURSING
 *  into nested compositions (compound layers and layout-cell comps). A
 *  `Composition` satisfies the parameter shape. */
export function referencedMediaIds(p: Pick<Project, 'layers' | 'audioClips'>): string[] {
  return [...new Set(mediaUses(p).map((u) => u.mediaId))]
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

/**
 * Whether this clip should be heard at all. The preview and the export both ask
 * this, then act on it differently — the preview holds an inaudible clip at gain
 * 0 (so it keeps following the playhead), the export leaves it out of the mix
 * (so it never decodes a source contributing nothing). Same decision, one place,
 * per the preview/export parity rule.
 */
export function audioClipAudible(c: Pick<AudioClip, 'mute'>): boolean {
  return !c.mute
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

/** An empty timeline core — the seed for a new project AND for a fresh nested
 *  composition (compound clip / layout-cell comp). One source of defaults. */
export function createEmptyComposition(): Composition {
  return {
    layers: [],
    captions: {
      enabled: false,
      stylePreset: 'reels-bold',
      yBaseline: 1340,
      style: { ...DEFAULT_CAPTION_STYLE },
      segments: []
    },
    audioClips: []
  }
}

/** Current document schema version (bump + add a `migrateProject` step). */
export const PROJECT_VERSION = 28

export function createEmptyProject(id: string, name: string): Project {
  const now = new Date().toISOString()
  return {
    id,
    name,
    version: PROJECT_VERSION,
    preset: DEFAULT_PRESET_ID,
    ...createEmptyComposition(),
    denoiseDefault: false,
    stabilizeDefault: null,
    script: [],
    mediaIds: [],
    volumeLevels: [defaultVolumeLevel()],
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
  const normFont = (id: unknown): string => (typeof id === 'string' && isKnownFont(id) ? id : DEFAULT_FONT_ID)
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
  // v13 adds absence-tolerant video `speedRamp` (absent = constant speed, no
  // transform).
  // v14 adds the `layout` layer content kind (multi-clip split screen/panels) —
  // purely additive, old projects simply have none.
  // v15 adds absence-tolerant keyframe `opacity` (absent = 1, no transform).
  // v16 adds absence-tolerant `linkGroupId` on layers/captions/audio clips
  // (absent = unlinked) — old projects simply have no link groups. Groups left
  // with a single member behave as unlinked, so no data transform is needed.
  // v17 adds nested compositions: the `compound` layer content kind and the
  // absence-tolerant `LayoutCell.comp` — purely additive, old projects simply
  // have none.
  // v18 OPENS the cell-level mute on every cell that carries a comp. Cells
  // default to muted (four panels shouting at once is chaos), which is right
  // for a single clip but wrong for a composition: a comp mixes its own audio,
  // per clip and on its own lane, so the cell gate silently overrode those
  // choices — audible while editing the comp, silent from the parent. Comps
  // converted before this shipped kept `mute: true` with no way to see or
  // change it, so re-open them all; a deliberate panel mute wasn't expressible
  // before the "mute this panel" toggle existed, so nothing intentional is lost.
  if ((p.version ?? 0) < 18 && Array.isArray(p.layers)) {
    const openCompCells = (layers: Layer[]): void => {
      for (const l of layers) {
        if (l.content.kind === 'compound') openCompCells(l.content.comp.layers)
        if (l.content.kind !== 'layout') continue
        for (const cell of l.content.cells) {
          if (!cell.comp) continue
          cell.mute = false
          openCompCells(cell.comp.layers)
        }
      }
    }
    openCompCells(p.layers)
  }
  // v19 adds generated audio effect tracks (the absence-tolerant
  // `AudioClip.fx` provenance and the `'fx'` audio kind) and text decoration
  // effects (`TextContent.effects`). Both purely additive — an effect track is
  // an ordinary audio clip and absent `effects` means none — so older projects
  // simply have neither and nothing about their existing content changes.
  // v20 RENAMES the original stacking effect from "chorus" to "ensemble" and
  // frees the name for a real chorus (LFO-swept detune, `vibrato`). Everything
  // saved before this shipped under `kind: 'chorus'` was the fixed-detune
  // effect, so it moves wholesale to `'ensemble'` — carrying its settings, so
  // existing effect tracks keep sounding exactly as they were rendered. Effect
  // clips live on every composition, so this recurses into nested comps.
  if ((p.version ?? 0) < 20) {
    const renameFx = (clips: AudioClip[]): void => {
      for (const a of clips) {
        const st = a.fx?.settings as { kind: string; chorus?: unknown; ensemble?: unknown } | undefined
        if (st?.kind === 'chorus' && st.chorus !== undefined) {
          st.kind = 'ensemble'
          st.ensemble = st.chorus
          delete st.chorus
        }
      }
    }
    const walk = (layers: Layer[]): void => {
      for (const l of layers) {
        if (l.content.kind === 'compound') {
          renameFx(l.content.comp.audioClips)
          walk(l.content.comp.layers)
        }
        if (l.content.kind !== 'layout') continue
        for (const cell of l.content.cells) {
          if (!cell.comp) continue
          renameFx(cell.comp.audioClips)
          walk(cell.comp.layers)
        }
      }
    }
    if (Array.isArray(p.audioClips)) renameFx(p.audioClips)
    if (Array.isArray(p.layers)) walk(p.layers)
  }
  // v21 adds per-clip audio mute (`AudioClip.mute`). Purely additive — absent
  // means audible, which is what every older project means — so nothing about
  // existing content changes and no rewrite step is needed.
  // v22 makes `preset` a key of the format registry (shared/formats.ts — ten
  // aspect ratios, vertical to 21:9) and a non-9:16 format a window CENTRED on
  // the canonical 1080×1920 space rather than a squash of it. No layer data
  // moves (a format only ever changes the frame), but an id this build does not
  // know — a newer build's format, a hand-edited file — normalises to the
  // default instead of leaving every preset lookup undefined.
  if (!isPresetId(p.preset)) p.preset = DEFAULT_PRESET_ID
  // v23 adds free-angle layer rotation (`Layer.rotationDeg`) and video flips
  // (`VideoContent.flipH`/`flipV`). Purely additive — absent means upright and
  // unflipped, which is what every older layer is — so nothing is rewritten.
  // v24 moved media ownership into the project folder (hard-linked originals,
  // docs/archived/PROJECT-FOLDERS.md) — a short-lived format main now refuses.
  // v25 makes library items POINTERS to originals in place, saved in the .reel
  // beside the document (docs/MEDIA-POINTERS.md). The library records are
  // main's (projectStore strips them before this runs and writes them on
  // Save); nothing in the document itself changes, and main refuses or
  // converts older files before they get here, so the version only records
  // which side of that line a file is on.
  // v26 adds volume levels: `Project.volumeLevels` (named loudness targets,
  // with a permanent Default at -16 LUFS) and the absence-tolerant
  // `AudioClip.volumeLevelId`. Every project gets Default, but NO existing clip
  // joins it — a finished reel must sound exactly as it did — so the only
  // rewrite is the level list itself (normalised on every load, so a
  // hand-edited file can't lose Default either).
  p.volumeLevels = normalizeVolumeLevels(p.volumeLevels)
  // v27 adds the `graphics` layer content kind (shapes + telestrator marks,
  // shared/graphics.ts) — purely additive, old projects simply have none.
  // v28 adds the absence-tolerant `VideoContent.pose` overlay settings
  // (shared/pose.ts) — absent means no overlay, so nothing is rewritten.
  if (typeof p.version !== 'number' || p.version < PROJECT_VERSION) p.version = PROJECT_VERSION
  // Projects saved before the library was project-scoped have no mediaIds; seed
  // the list from whatever media they already reference so their library isn't
  // empty on open.
  if (!Array.isArray(p.mediaIds)) p.mediaIds = referencedMediaIds(p as Project)
  return p as Project
}
