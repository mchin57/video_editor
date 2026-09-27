/**
 * Output formats — the frame shapes a project is edited and exported in.
 *
 * Two levels, the second inheriting from the first:
 *
 *  - an ASPECT (`defineAspect`) is a pure shape. Only its ratio is written down;
 *    the output size (short side `SHORT_SIDE`, even dims), orientation, ratio
 *    label and centred frame window are all DERIVED from it.
 *  - a PRESET (`definePreset`) is what a project picks. It extends one aspect —
 *    inheriting all of the above — adds a name, and may layer platform extras on
 *    top (Instagram's UI safe zones, a max duration hint).
 *
 * Adding a format is one `ASPECTS` line plus one `EXPORT_PRESETS` line; the
 * Format menu, preview stage, export, crop tool, layout picker and checklist all
 * read from here. Every frame is a window centred on the canonical 1080×1920
 * logical space (`centeredFrame`), 1 logical px = 1 output px, so changing a
 * project's format never rewrites its layers.
 */

import { centeredFrame, type FrameRect } from './frame'

/** Every format's SHORT side, in output px (= logical px). */
export const SHORT_SIDE = 1080

export type Orientation = 'vertical' | 'square' | 'horizontal'

/** A frame shape. Everything but `ratio` is derived by `defineAspect`. */
export interface AspectFormat {
  /** The ratio as written, e.g. 16:9 → [16, 9]. */
  ratio: readonly [number, number]
  /** "16:9" */
  ratioLabel: string
  orientation: Orientation
  /** Output size in px — also the frame's size in logical px. */
  width: number
  height: number
  /** The frame as a window on the canonical logical space. */
  frame: FrameRect
}

/** A region the platform's own UI covers, in FRAME-relative px (0,0 = the
 *  frame's top-left) — text should stay out of it. */
export type SafeZone = { x: number; y: number; w: number; h: number }

/** What a project picks: an aspect plus a name and optional platform extras. */
export interface ExportPreset extends AspectFormat {
  id: string
  /** Menu / tooltip name, e.g. "Landscape (16:9)". */
  name: string
  /** Where it's typically used — shown as the menu hint. */
  hint?: string
  /** Platform UI regions drawn as guides and checked by the checklist. */
  safeZones?: readonly SafeZone[]
  /** Optional fixed/maximum duration hint in seconds (carousel slides are short). */
  maxDurationSec?: number
}

const even = (n: number): number => Math.round(n / 2) * 2

/** Derive a full aspect format from its ratio terms. */
export function defineAspect(rw: number, rh: number): AspectFormat {
  const short = Math.min(rw, rh)
  const width = rw === short ? SHORT_SIDE : even((SHORT_SIDE * rw) / short)
  const height = rh === short ? SHORT_SIDE : even((SHORT_SIDE * rh) / short)
  return {
    ratio: [rw, rh],
    ratioLabel: `${rw}:${rh}`,
    orientation: rw === rh ? 'square' : rw < rh ? 'vertical' : 'horizontal',
    width,
    height,
    frame: centeredFrame(width, height)
  }
}

/** The base shapes. Add a ratio here, then give it a preset below. */
export const ASPECTS = {
  '9:16': defineAspect(9, 16),
  '4:5': defineAspect(4, 5),
  '3:4': defineAspect(3, 4),
  '2:3': defineAspect(2, 3),
  '1:1': defineAspect(1, 1),
  '16:9': defineAspect(16, 9),
  '4:3': defineAspect(4, 3),
  '21:9': defineAspect(21, 9)
} as const

/** A preset: inherits everything from `aspect`, named `label (ratio)`. */
export function definePreset<I extends string>(
  id: I,
  label: string,
  aspect: AspectFormat,
  extras: Partial<Pick<ExportPreset, 'hint' | 'safeZones' | 'maxDurationSec'>> = {}
): ExportPreset & { id: I } {
  return { ...aspect, ...extras, id, name: `${label} (${aspect.ratioLabel})` }
}

/**
 * Instagram's Reels/Stories UI, in 9:16 frame px: the bottom ~25% holds the
 * caption / CTA / audio bar, the right ~10% the action rail.
 */
export const INSTAGRAM_SAFE_ZONES = {
  bottom: { x: 0, y: 1440, w: 1080, h: 480 },
  rightRail: { x: 972, y: 0, w: 108, h: 1920 }
} as const satisfies Record<string, SafeZone>

/** Everything the Instagram full-screen vertical presets share. */
const INSTAGRAM_VERTICAL = { safeZones: Object.values(INSTAGRAM_SAFE_ZONES) }

/** The pickable formats, in menu order (grouped by orientation in the UI). */
export const EXPORT_PRESETS = {
  reel: definePreset('reel', 'Reel', ASPECTS['9:16'], { hint: 'Instagram Reels', ...INSTAGRAM_VERTICAL }),
  story: definePreset('story', 'Story', ASPECTS['9:16'], { hint: 'Instagram Stories', ...INSTAGRAM_VERTICAL }),
  carousel: definePreset('carousel', 'Carousel slide', ASPECTS['9:16'], {
    hint: 'Instagram carousel',
    ...INSTAGRAM_VERTICAL,
    maxDurationSec: 5
  }),
  feed: definePreset('feed', 'Feed post', ASPECTS['4:5'], { hint: 'Instagram / Facebook feed' }),
  portrait: definePreset('portrait', 'Portrait', ASPECTS['3:4']),
  pin: definePreset('pin', 'Pin', ASPECTS['2:3'], { hint: 'Pinterest' }),
  square: definePreset('square', 'Square', ASPECTS['1:1'], { hint: 'Feed, profile grid' }),
  landscape: definePreset('landscape', 'Landscape', ASPECTS['16:9'], { hint: 'YouTube, TV, desktop' }),
  classic: definePreset('classic', 'Classic', ASPECTS['4:3']),
  cinematic: definePreset('cinematic', 'Cinematic', ASPECTS['21:9'], { hint: 'Ultrawide' })
}

export type PresetId = keyof typeof EXPORT_PRESETS

export const DEFAULT_PRESET_ID: PresetId = 'reel'

export function isPresetId(id: unknown): id is PresetId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_PRESETS, id)
}

/** The preset for `id`, falling back to the default (Reel) for anything unknown —
 *  a project from a newer build, or a hand-edited file, still opens. */
export function presetFor(id: string | null | undefined): ExportPreset {
  return isPresetId(id) ? EXPORT_PRESETS[id] : EXPORT_PRESETS[DEFAULT_PRESET_ID]
}

/** Whether the preset is full-screen vertical 9:16 (what Reels/Stories favor). */
export function isNineSixteen(p: AspectFormat): boolean {
  return p.ratio[0] * 16 === p.ratio[1] * 9
}

const ORIENTATION_ORDER: Orientation[] = ['vertical', 'square', 'horizontal']
const ORIENTATION_LABEL: Record<Orientation, string> = {
  vertical: 'Vertical',
  square: 'Square',
  horizontal: 'Horizontal'
}

/** Presets grouped by orientation, in menu order (for `<optgroup>`s). */
export function presetGroups(): { label: string; presets: ExportPreset[] }[] {
  const all = Object.values(EXPORT_PRESETS) as ExportPreset[]
  return ORIENTATION_ORDER.map((o) => ({
    label: ORIENTATION_LABEL[o],
    presets: all.filter((p) => p.orientation === o)
  })).filter((g) => g.presets.length > 0)
}
