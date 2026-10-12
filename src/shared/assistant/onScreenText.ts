/**
 * On-screen text for the AI assistant: what `get_text` reports and the edit
 * shape `set_text` accepts. Text layers and caption segments are ONE surface
 * here (both are "text the viewer reads"), addressed by their timeline id; the
 * caption lane itself answers to the reserved id `captions`. Pure.
 * The edits are applied by the renderer (`lib/textEdits.ts`).
 */

import type { Composition, GradientStyle, PillStyle, ShadowStyle, StrokeStyle, TimelineItemRef } from '../project'
import { effectiveCaptionStyle } from '../project'
import type { TextAnimation } from '../textAnim'

/** Reserved `set_text` / `get_text` id for the caption lane (on/off + lane-wide style). */
export const CAPTION_LANE_ID = 'captions'

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
  hiddenBecause?: 'layer hidden' | 'caption disabled' | 'caption lane off'
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
 * owns link-group semantics).
 */
export function summarizeText(
  comp: Composition,
  isLinked: (ref: TimelineItemRef) => boolean,
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
      visible: lane.enabled && seg.enabled,
      linked: isLinked({ kind: 'caption', id: seg.id }),
      ...look(st),
      x: r1(st.x),
      y: r1(st.y),
      rotationDeg: st.rotationDeg,
      styleFrom: seg.style ? 'own' : 'lane'
    }
    if (!seg.enabled) s.hiddenBecause = 'caption disabled'
    else if (!lane.enabled) s.hiddenBecause = 'caption lane off'
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
