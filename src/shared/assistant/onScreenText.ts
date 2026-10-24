/**
 * On-screen text for the AI assistant: what `get_text` reports and the edit
 * shape `set_text` accepts. Text layers and caption segments are ONE surface
 * here (both are "text the viewer reads"), addressed by their timeline id; the
 * caption lane itself answers to the reserved id `captions`. Pure.
 * The edits are applied by the renderer (`lib/textEdits.ts`).
 */

import type { Composition, GradientStyle, PillStyle, ShadowStyle, StrokeStyle, TimelineItemRef } from '../project'
import { effectiveCaptionStyle } from '../project'
import { FRAME } from '../frame'
import type { TextAnimation } from '../textAnim'

/** Reserved `set_text` / `get_text` id for the caption lane (on/off + lane-wide style). */
export const CAPTION_LANE_ID = 'captions'

/** `set_text` limits, shared by the MCP schema and the renderer's validation. */
export const MIN_TEXT_SEC = 0.1
export { TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX, TEXT_PILL_PAD_MAX } from '../textStyle'
/** How far past the current end of the edit text may reach (catches ms-for-seconds slips). */
export const MAX_TEXT_PAST_END_SEC = 60
/** The latest an item may end in an edit `durationSec` long: `set_text`'s limit
 *  and the Inspector's End (s) bound for layers and captions. One rule, so a
 *  typed End can't store a time the assistant would reject (an unbounded End
 *  once crashed the timeline). */
export function maxItemEndSec(durationSec: number): number {
  return durationSec + MAX_TEXT_PAST_END_SEC
}
/** Half of get_text's 1 ms rounding: a time this close to the current one is "unchanged". */
export const TEXT_TIME_EPS = 0.0005

/** Longest `text` set_text takes. Unbounded, a 200,000-character layer made
 *  render_frame / export_video take ~25 s instead of under 1 s. */
export const TEXT_MAX_CHARS = 2000
/** Control characters `text` may not hold: every one but tab and newline (a NUL
 *  once got through). The Inspector's text box takes both of those. */
// eslint-disable-next-line no-control-regex
export const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
/** set_text's bounds on a text centre (logical px): a whole FRAME past each
 *  edge, which still holds the widest output window (21:9 reaches 720 px past
 *  the sides). The Inspector leaves position unbounded, but 1e308 was stored and
 *  then read back as null. */
export const TEXT_X_MIN = -FRAME.width
export const TEXT_X_MAX = 2 * FRAME.width
export const TEXT_Y_MIN = -FRAME.height
export const TEXT_Y_MAX = 2 * FRAME.height
/** set_text's rotation bound (degrees, either way): any angle fits in a turn. */
export const TEXT_ROTATION_MAX_DEG = 360
/** set_text's gradient angle range (degrees): the Inspector's Angle slider's. */
export const GRADIENT_ANGLE_MIN = 0
export const GRADIENT_ANGLE_MAX = 360

/** Why `text` can't be set (empty, too long, control characters), or null. */
export function textProblem(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'text must not be empty (use remove_items to delete an item)'
  if (text.length > TEXT_MAX_CHARS) return `text must be at most ${TEXT_MAX_CHARS} characters (it has ${text.length})`
  if (TEXT_CONTROL_CHARS.test(text)) return 'text must not contain control characters (newline and tab are fine)'
  return null
}

/** The style fields every on-screen text item has (text layer or caption). */
export interface TextLook {
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
  stroke: StrokeStyle | null
  shadow: ShadowStyle | null
  gradient: GradientStyle | null
  /** Centre in logical 1080×1920 px. */
  x: number
  y: number
  rotationDeg: number
}

export interface TextItemSummary extends TextLook {
  id: string
  kind: 'text' | 'caption'
  startSec: number
  endSec: number
  text: string
  /** False when the viewer won't see it; `hiddenBecause` says why. */
  visible: boolean
  hiddenBecause?: 'layer hidden' | 'caption disabled' | 'caption lane off' | 'after the end of the edit'
  /** Captions only: the edit ends at this second, part-way through the caption (the rest never shows). */
  cutOffAtSec?: number
  /** In a link group with another tile: `set_text` refuses timing changes on it. */
  linked: boolean
  /** Text layers: uniform zoom on top of `fontSizePx` (1 = natural). */
  scale?: number
  /** Text layers: explicit wrap width in logical px (absent = hugs the text). */
  widthPx?: number
  /** Text layers: entrance/exit animation, when set. */
  animation?: TextAnimation
  /** Captions: 'lane' = follows the lane-wide style; 'own' = has its own override. */
  styleFrom?: 'lane' | 'own'
}

export interface CaptionLaneSummary extends TextLook {
  id: typeof CAPTION_LANE_ID
  visible: boolean
}

export interface OnScreenText {
  /** Length of the edit. Captions don't extend it: one starting at or after it never shows. */
  durationSec: number
  captionLane: CaptionLaneSummary
  /** Timeline order (start time; text layers before captions on a tie). */
  items: TextItemSummary[]
}

export interface TextQuery {
  ids?: string[]
  /** Keep items on screen at some point in [fromSec, toSec] (TIMELINE seconds). */
  fromSec?: number
  toSec?: number
}

/**
 * One `set_text` edit. WITH `id`: patch that item (only the fields given change).
 * WITHOUT `id`: create a new item — `kind` (default 'text'), `text`, `startSec`
 * and `endSec` are required; unset style falls back to the UI's defaults.
 * `id: 'captions'` patches the caption lane (visible + style/position only).
 * Nested `pill` merges field-by-field; `stroke`/`shadow`/`gradient` replace
 * (null removes). TIMELINE seconds; logical px.
 */
export interface TextEdit {
  id?: string
  kind?: 'text' | 'caption'
  text?: string
  startSec?: number
  endSec?: number
  visible?: boolean
  x?: number
  y?: number
  rotationDeg?: number
  fontFamily?: string
  fontSizePx?: number
  color?: string
  pill?: Partial<PillStyle>
  stroke?: StrokeStyle | null
  shadow?: ShadowStyle | null
  gradient?: GradientStyle | null
  /** Text layers only: wrap width in logical px; null = hug the text. */
  widthPx?: number | null
  /** Captions only: true drops the caption's own style so it follows the lane again. */
  followLaneStyle?: boolean
}

export interface TextEditResult {
  id: string
  kind: 'text' | 'caption' | 'captionLane'
  created: boolean
  /** Something the model should know (e.g. the caption lane is off). */
  note?: string
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000
const r1 = (n: number): number => Math.round(n * 10) / 10

function look(s: {
  fontFamily: string
  fontSizePx: number
  color: string
  pill: PillStyle
  stroke?: StrokeStyle | null
  shadow?: ShadowStyle | null
  gradient?: GradientStyle | null
}): Omit<TextLook, 'x' | 'y' | 'rotationDeg'> {
  return {
    fontFamily: s.fontFamily,
    fontSizePx: s.fontSizePx,
    color: s.color,
    pill: { ...s.pill },
    stroke: s.stroke ?? null,
    shadow: s.shadow ?? null,
    gradient: s.gradient ?? null
  }
}

/**
 * Every text layer and caption segment of `comp`, with the style it actually
 * renders with. `isLinked` comes from the caller (the renderer's `lib/links.ts`
 * owns link-group semantics); `durationSec` is the edit's length
 * (`compositionDuration`), which captions do not extend.
 */
export function summarizeText(
  comp: Composition,
  isLinked: (ref: TimelineItemRef) => boolean,
  durationSec: number,
  q: TextQuery = {}
): OnScreenText {
  const lane = comp.captions
  const items: TextItemSummary[] = []

  for (const l of comp.layers) {
    const c = l.content
    if (c.kind !== 'text') continue
    const s: TextItemSummary = {
      id: l.id,
      kind: 'text',
      startSec: r3(l.startSec),
      endSec: r3(l.endSec),
      text: c.text,
      visible: !l.hidden,
      linked: isLinked({ kind: 'layer', id: l.id }),
      ...look(c),
      x: r1(l.x),
      y: r1(l.y),
      rotationDeg: l.rotationDeg ?? 0,
      scale: l.scale
    }
    if (l.hidden) s.hiddenBecause = 'layer hidden'
    if (c.widthPx !== undefined) s.widthPx = c.widthPx
    if (c.animation) s.animation = c.animation
    items.push(s)
  }

  for (const seg of lane.segments) {
    const st = effectiveCaptionStyle(lane, seg)
    const s: TextItemSummary = {
      id: seg.id,
      kind: 'caption',
      startSec: r3(seg.startSec),
      endSec: r3(seg.endSec),
      text: seg.text,
      visible: lane.enabled && seg.enabled && seg.startSec < durationSec,
      linked: isLinked({ kind: 'caption', id: seg.id }),
      ...look(st),
      x: r1(st.x),
      y: r1(st.y),
      rotationDeg: st.rotationDeg,
      styleFrom: seg.style ? 'own' : 'lane'
    }
    if (!seg.enabled) s.hiddenBecause = 'caption disabled'
    else if (!lane.enabled) s.hiddenBecause = 'caption lane off'
    else if (seg.startSec >= durationSec) s.hiddenBecause = 'after the end of the edit'
    if (seg.startSec < durationSec && seg.endSec > durationSec) s.cutOffAtSec = r3(durationSec)
    items.push(s)
  }

  const ids = q.ids ? new Set(q.ids) : null
  const from = q.fromSec ?? -Infinity
  const to = q.toSec ?? Infinity
  const kept = items
    // On screen during [start, end): fromSec === toSec asks "what shows at t".
    .filter((i) => (!ids || ids.has(i.id)) && i.endSec > from && i.startSec <= to)
    .sort((a, b) => a.startSec - b.startSec || (a.kind === b.kind ? 0 : a.kind === 'text' ? -1 : 1))

  return {
    durationSec: r3(durationSec),
    captionLane: {
      id: CAPTION_LANE_ID,
      visible: lane.enabled,
      ...look(lane.style),
      x: r1(lane.style.x),
      y: r1(lane.style.y),
      rotationDeg: lane.style.rotationDeg
    },
    items: kept
  }
}
