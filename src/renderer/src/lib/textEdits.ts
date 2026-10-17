/**
 * Apply the assistant's `set_text` edits to a composition — create or patch
 * text layers and caption segments, or restyle the caption lane — as ONE pure
 * transform the store commits as a single undo step. Every edit is validated
 * first; if any is bad nothing is applied and the error names each problem, so
 * a batch never lands half-done. New text layers come from the shared
 * `makeTextLayer`; caption words stay in step via `captionWithText` /
 * `captionInWindow` (see their docs for why that matters).
 */

import type { CaptionSegment, CaptionStyle, Composition, Layer, TextContent } from '@shared/project'
import type { FrameRect } from '@shared/frame'
import { FONTS, isKnownFont } from '@shared/fonts'
import { makeTextLayer } from '@shared/layers'
import {
  CAPTION_LANE_ID,
  MAX_TEXT_PAST_END_SEC,
  maxItemEndSec,
  MIN_TEXT_SEC,
  TEXT_FONT_SIZE_MAX,
  TEXT_PILL_PAD_MAX,
  TEXT_TIME_EPS,
  TEXT_FONT_SIZE_MIN,
  type TextEdit,
  type TextEditResult
} from '@shared/assistant/onScreenText'
import { captionInWindow, captionWithText, makeCaption } from './captions'
import { isLinked } from './links'

const KNOWN_KEYS = new Set<keyof TextEdit>([
  'id',
  'kind',
  'text',
  'startSec',
  'endSec',
  'visible',
  'x',
  'y',
  'rotationDeg',
  'fontFamily',
  'fontSizePx',
  'color',
  'pill',
  'stroke',
  'shadow',
  'gradient',
  'widthPx',
  'followLaneStyle'
])
/** Fields that restyle a text block (shared by text layers, captions and the lane). */
const STYLE_KEYS = ['fontFamily', 'fontSizePx', 'color', 'pill', 'stroke', 'shadow', 'gradient'] as const
const POSITION_KEYS = ['x', 'y', 'rotationDeg'] as const
const LANE_KEYS = new Set<string>(['id', 'visible', ...STYLE_KEYS, ...POSITION_KEYS])

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i

export interface TextEditCtx {
  newId: () => string
  /** The project's output frame (new text layers sit a third of the way down it). */
  frame: FrameRect
  /** The edit's length before these edits (seconds) — text may not start or end
   *  more than `MAX_TEXT_PAST_END_SEC` past it. */
  durationSec: number
}

export interface TextEditOutcome {
  comp: Composition
  results: TextEditResult[]
}

type StylePatch = Pick<TextEdit, (typeof STYLE_KEYS)[number]>

/** Problems with the style/position fields of one edit (shared by every target). */
function styleProblems(e: TextEdit): string[] {
  const p: string[] = []
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const inRange = (name: string, v: unknown, lo: number, hi: number): void => {
    if (v !== undefined && (!finite(v) || v < lo || v > hi)) p.push(`${name} must be a number from ${lo} to ${hi}`)
  }
  const color = (name: string, v: unknown): void => {
    if (v !== undefined && (typeof v !== 'string' || !HEX.test(v)))
      p.push(`${name} must be a hex colour like #ffffff or #000000cc`)
  }
  if (e.fontFamily !== undefined && !isKnownFont(e.fontFamily)) {
    p.push(`unknown font "${e.fontFamily}"; fonts: ${FONTS.map((f) => f.id).join(', ')}`)
  }
  inRange('fontSizePx', e.fontSizePx, TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX)
  color('color', e.color)
  for (const k of POSITION_KEYS) if (e[k] !== undefined && !finite(e[k])) p.push(`${k} must be a number`)
  if (e.pill !== undefined) {
    if (e.pill === null || typeof e.pill !== 'object') p.push('pill must be an object')
    else {
      color('pill.color', e.pill.color)
      inRange('pill.padPx', e.pill.padPx, 0, TEXT_PILL_PAD_MAX)
      if (e.pill.enabled !== undefined && typeof e.pill.enabled !== 'boolean')
        p.push('pill.enabled must be true or false')
    }
  }
  if (e.stroke) {
    inRange('stroke.widthPx', e.stroke.widthPx, 0, 100)
    color('stroke.color', e.stroke.color)
  }
  if (e.shadow) {
    inRange('shadow.distancePx', e.shadow.distancePx, 0, 100)
    inRange('shadow.blur', e.shadow.blur, 0, 50)
    color('shadow.color', e.shadow.color)
  }
  if (e.gradient) {
    color('gradient.from', e.gradient.from)
    color('gradient.to', e.gradient.to)
    if (!finite(e.gradient.angle)) p.push('gradient.angle must be a number')
  }
  if (e.widthPx !== undefined && e.widthPx !== null) inRange('widthPx', e.widthPx, 40, 4000)
  return p
}

/** Apply the style fields of `e` onto a text style (text layer content or caption style). */
function withStyle<T extends StylePatch & { pill: TextContent['pill'] }>(base: T, e: TextEdit): T {
  const out = { ...base }
  if (e.fontFamily !== undefined) out.fontFamily = e.fontFamily
  if (e.fontSizePx !== undefined) out.fontSizePx = e.fontSizePx
  if (e.color !== undefined) out.color = e.color
  if (e.pill !== undefined) out.pill = { ...base.pill, ...e.pill }
  if (e.stroke !== undefined) out.stroke = e.stroke
  if (e.shadow !== undefined) out.shadow = e.shadow
  if (e.gradient !== undefined) out.gradient = e.gradient
  return out
}

function withCaptionStyle(base: CaptionStyle, e: TextEdit): CaptionStyle {
  const out = withStyle(base, e)
  if (e.x !== undefined) out.x = e.x
  if (e.y !== undefined) out.y = e.y
  if (e.rotationDeg !== undefined) out.rotationDeg = e.rotationDeg
  return out
}

const touchesStyle = (e: TextEdit): boolean => [...STYLE_KEYS, ...POSITION_KEYS].some((k) => e[k] !== undefined)

/**
 * The [start, end) an edit asks for, or a problem. An existing item keeps its
 * exact window unless the edit really moves it (`retimes`) — get_text reports
 * rounded times, and echoing them back must not nudge anything.
 */
function windowOf(
  e: TextEdit,
  cur: { startSec: number; endSec: number } | null,
  durationSec: number
): [number, number] | string {
  if (cur && !retimes(e, cur)) return [cur.startSec, cur.endSec]
  // Per edge: one that only echoes the current value keeps it exactly.
  const s = cur && !movesEdge(e.startSec, cur.startSec) ? cur.startSec : e.startSec
  const t = cur && !movesEdge(e.endSec, cur.endSec) ? cur.endSec : e.endSec
  if (s === undefined || t === undefined) return 'a new item needs startSec and endSec'
  if (!Number.isFinite(s) || !Number.isFinite(t)) return 'startSec and endSec must be numbers'
  if (s < 0) return 'startSec must be 0 or more'
  if (t - s < MIN_TEXT_SEC) return `endSec must be at least ${MIN_TEXT_SEC}s after startSec`
  const limit = maxItemEndSec(durationSec)
  if (t > limit) {
    return `endSec ${t} is more than ${MAX_TEXT_PAST_END_SEC}s past the end of the edit (${Math.round(durationSec * 100) / 100}s); times are in seconds`
  }
  return [s, t]
}

const laneOffNote =
  'The caption lane is off, so this caption will not show; set visible: true on id "captions" to turn the lane on.'

/** Apply `edits` in order. Throws (applying nothing) if any edit is invalid. */
export function applyTextEdits(comp: Composition, edits: TextEdit[], ctx: TextEditCtx): TextEditOutcome {
  let c = comp
  const results: TextEditResult[] = []
  const errors: string[] = []

  edits.forEach((e, i) => {
    const label = `edit ${i + 1}${e.id ? ` (id "${e.id}")` : ' (new)'}`
    const fail = (msg: string): void => void errors.push(`${label}: ${msg}`)
    const unknown = Object.keys(e).filter((k) => !KNOWN_KEYS.has(k as keyof TextEdit))
    if (unknown.length) return fail(`unknown field ${unknown.join(', ')}`)
    // An id alone changes nothing; accepting it recorded an empty undo step.
    if (e.id !== undefined && Object.keys(e).every((k) => k === 'id')) {
      return fail('nothing to change: give at least one field to set besides id')
    }
    const style = styleProblems(e)
    if (style.length) return fail(style.join('; '))
    if (e.text !== undefined && (typeof e.text !== 'string' || !e.text.trim())) {
      return fail('text must not be empty (use remove_items to delete an item)')
    }
    if (e.visible !== undefined && typeof e.visible !== 'boolean') return fail('visible must be true or false')

    // --- the caption lane ---------------------------------------------------
    if (e.id === CAPTION_LANE_ID) {
      const bad = Object.keys(e).filter((k) => !LANE_KEYS.has(k))
      if (bad.length)
        return fail(`the caption lane only takes visible, position and style fields, not ${bad.join(', ')}`)
      c = {
        ...c,
        captions: {
          ...c.captions,
          enabled: e.visible ?? c.captions.enabled,
          style: withCaptionStyle(c.captions.style, e)
        }
      }
      results.push({ id: CAPTION_LANE_ID, kind: 'captionLane', created: false })
      return
    }

    // --- create ---------------------------------------------------------------
    if (e.id === undefined) {
      const kind = e.kind ?? 'text'
      if (kind !== 'text' && kind !== 'caption') return fail('kind must be "text" or "caption"')
      if (e.text === undefined) return fail('a new item needs text')
      const win = windowOf(e, null, ctx.durationSec)
      if (typeof win === 'string') return fail(win)
      const [startSec, endSec] = win
      const id = ctx.newId()
      if (kind === 'text') {
        if (e.followLaneStyle !== undefined) return fail('followLaneStyle is for captions only')
        const base = makeTextLayer(id, startSec, endSec, ctx.frame)
        c = { ...c, layers: [...c.layers, patchTextLayer({ ...base, startSec, endSec }, e)] }
        results.push({ id, kind: 'text', created: true })
      } else {
        if (e.widthPx !== undefined) return fail('widthPx is for text layers only')
        let seg: CaptionSegment = { ...makeCaption(id, startSec, endSec, e.text), enabled: e.visible ?? true }
        if (touchesStyle(e)) seg = { ...seg, style: withCaptionStyle(c.captions.style, e) }
        const segments = [...c.captions.segments, seg].sort((a, b) => a.startSec - b.startSec)
        c = { ...c, captions: { ...c.captions, segments } }
        results.push({ id, kind: 'caption', created: true, ...(c.captions.enabled ? {} : { note: laneOffNote }) })
      }
      return
    }

    if (e.kind !== undefined) return fail('kind is only for creating (leave out id)')

    // --- patch a text layer -----------------------------------------------------
    const layer = c.layers.find((l) => l.id === e.id)
    if (layer) {
      if (layer.content.kind !== 'text') return fail(`that is a ${layer.content.kind} layer, not text`)
      if (e.followLaneStyle !== undefined) return fail('followLaneStyle is for captions only')
      const win = windowOf(e, layer, ctx.durationSec)
      if (typeof win === 'string') return fail(win)
      if (retimes(e, layer) && isLinked(c, { kind: 'layer', id: layer.id })) return fail(linkedMsg)
      const next = patchTextLayer({ ...layer, startSec: win[0], endSec: win[1] }, e)
      c = { ...c, layers: c.layers.map((l) => (l.id === layer.id ? next : l)) }
      results.push({ id: layer.id, kind: 'text', created: false })
      return
    }

    // --- patch a caption ----------------------------------------------------------
    const seg = c.captions.segments.find((s) => s.id === e.id)
    if (seg) {
      if (e.widthPx !== undefined) return fail('widthPx is for text layers only')
      if (e.followLaneStyle !== undefined && typeof e.followLaneStyle !== 'boolean') {
        return fail('followLaneStyle must be true or false')
      }
      if (e.followLaneStyle && touchesStyle(e))
        return fail('followLaneStyle: true cannot be combined with style or position fields')
      const win = windowOf(e, seg, ctx.durationSec)
      if (typeof win === 'string') return fail(win)
      if (retimes(e, seg) && isLinked(c, { kind: 'caption', id: seg.id })) return fail(linkedMsg)
      let next = retimes(e, seg) ? captionInWindow(seg, win[0], win[1]) : seg
      if (e.text !== undefined) next = captionWithText(next, e.text)
      if (e.visible !== undefined) next = { ...next, enabled: e.visible }
      if (e.followLaneStyle) next = { ...next, style: null }
      else if (touchesStyle(e)) next = { ...next, style: withCaptionStyle(next.style ?? c.captions.style, e) }
      const segments = c.captions.segments
        .map((s) => (s.id === seg.id ? next : s))
        .sort((a, b) => a.startSec - b.startSec)
      c = { ...c, captions: { ...c.captions, segments } }
      const note = next.enabled && !c.captions.enabled ? laneOffNote : undefined
      results.push({ id: seg.id, kind: 'caption', created: false, ...(note ? { note } : {}) })
      return
    }

    fail('no text layer or caption has this id (get_text lists them)')
  })

  if (errors.length) throw new Error(`Nothing was changed:\n${errors.join('\n')}`)
  return { comp: c, results }
}

const linkedMsg =
  'it is linked to another timeline item, so its timing cannot change on its own (text and style edits are fine); unlink it in the editor or leave startSec/endSec out'

/** Whether an edge value moves it (beyond get_text's rounding). */
function movesEdge(v: number | undefined, now: number): boolean {
  return v !== undefined && !(Math.abs(v - now) <= TEXT_TIME_EPS)
}

/** Whether the edit moves or resizes the item's window. */
function retimes(e: TextEdit, cur: { startSec: number; endSec: number }): boolean {
  return movesEdge(e.startSec, cur.startSec) || movesEdge(e.endSec, cur.endSec)
}

/** A text layer with the edit's content/position/visibility fields applied (timing is the caller's). */
function patchTextLayer(layer: Layer, e: TextEdit): Layer {
  const content = withStyle(layer.content as TextContent, e)
  if (e.text !== undefined) content.text = e.text
  if (e.widthPx === null) delete content.widthPx
  else if (e.widthPx !== undefined) content.widthPx = e.widthPx
  const out: Layer = { ...layer, content }
  if (e.x !== undefined) out.x = e.x
  if (e.y !== undefined) out.y = e.y
  if (e.rotationDeg !== undefined) out.rotationDeg = e.rotationDeg
  if (e.visible !== undefined) out.hidden = !e.visible
  return out
}
