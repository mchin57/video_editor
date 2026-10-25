/**
 * Graphics layers: shapes and telestrator marks (arrow, line, rectangle,
 * ellipse, angle) drawn over the picture. ONE implementation of how a mark
 * looks — `markShapes` turns a mark into SVG paths + a label, and both the
 * preview (React SVG) and the export (the same SVG, rasterised by the export's
 * Chromium, `services/textImage.ts`) draw exactly those. Timing (`markStateAt`)
 * is shared the same way: the export samples it for its draw-on frames and
 * mirrors its linear fade, so a reveal looks the same on both sides.
 *
 * Marks live in the canonical 1080×1920 space BEFORE the layer transform: the
 * graphics layer's x/y/scale move/zoom the whole drawing about the frame centre
 * (`toCanvas`), so Motion keyframes on the layer carry every mark with it.
 */

import { FRAME } from './frame'
import { DEFAULT_FONT_ID, fontCssFamily } from './fonts'

export interface Pt {
  x: number
  y: number
}

export const GRAPHIC_TOOLS = ['arrow', 'line', 'rect', 'ellipse', 'angle'] as const
export type GraphicTool = (typeof GRAPHIC_TOOLS)[number]

/** How a mark comes on screen at its `atSec`: at once, fading in, or drawn in
 *  stroke-first over `REVEAL_SEC`. */
export type MarkReveal = 'pop' | 'fade' | 'draw'
export const MARK_REVEALS: { id: MarkReveal; label: string }[] = [
  { id: 'pop', label: 'Pop' },
  { id: 'fade', label: 'Fade in' },
  { id: 'draw', label: 'Draw on' }
]

/** One mark of a graphics layer. */
export interface GraphicMark {
  id: string
  tool: GraphicTool
  /**
   * Canonical logical px, before the layer transform. `arrow`/`line`: [tail,
   * tip]; `rect`/`ellipse`: two opposite corners of the box; `angle`: [vertex,
   * end of arm A, end of arm B].
   */
  points: Pt[]
  color: string
  /** Stroke width in logical px. */
  widthPx: number
  /** Fill colour of a rectangle/ellipse (absent/null = outline only). */
  fill?: string | null
  /** Rectangle corner radius in logical px (absent = square corners). */
  radiusPx?: number
  /** Rectangle/ellipse edits keep the box 1:1 (a square / a circle). */
  lockAspect?: boolean
  /** Seconds after the layer's start the mark appears (≥ 0). */
  atSec: number
  reveal: MarkReveal
}

/** Seconds a fade or a draw-on takes. */
export const REVEAL_SEC = 0.4
export const MARK_DEFAULTS = { color: '#FFD60A', widthPx: 8 } as const
/** A new graphics tile's length on the timeline. */
export const GRAPHICS_DEFAULT_SEC = 3

export const TOOL_INFO: Record<GraphicTool, { label: string; hint: string }> = {
  arrow: { label: 'Arrow', hint: 'Drag from the tail to the tip, or click where it should point' },
  line: { label: 'Line', hint: 'Drag from one end to the other, or click to drop one' },
  rect: { label: 'Rectangle', hint: 'Drag corner to corner, or click to drop one' },
  ellipse: { label: 'Ellipse', hint: 'Drag corner to corner, or click to drop one' },
  angle: { label: 'Angle', hint: 'Click the joint, then a point along each limb' }
}

// --- Layer transform ------------------------------------------------------------

/** The point the layer transform scales about: the canonical frame centre. A
 *  new graphics layer sits here at scale 1, so marks land where they're drawn. */
export const GRAPHICS_ORIGIN: Pt = { x: FRAME.width / 2, y: FRAME.height / 2 }

/** The layer transform a mark is drawn through (the layer's keyframed values). */
export interface GraphicsTransform {
  x: number
  y: number
  scale: number
}

/** Mark space → canonical canvas px through the layer transform. */
export function toCanvas(t: GraphicsTransform, p: Pt): Pt {
  return { x: t.x + t.scale * (p.x - GRAPHICS_ORIGIN.x), y: t.y + t.scale * (p.y - GRAPHICS_ORIGIN.y) }
}

/** Canonical canvas px → mark space (the inverse of `toCanvas`). */
export function fromCanvas(t: GraphicsTransform, p: Pt): Pt {
  const s = t.scale || 1
  return { x: GRAPHICS_ORIGIN.x + (p.x - t.x) / s, y: GRAPHICS_ORIGIN.y + (p.y - t.y) / s }
}

/** Where the layer transform puts a mark-space box: its centre and size in
 *  canonical px (the export composites each mark's raster here). */
export function placedBox(
  box: { x: number; y: number; w: number; h: number },
  t: GraphicsTransform
): { cx: number; cy: number; w: number; h: number } {
  const c = toCanvas(t, { x: box.x + box.w / 2, y: box.y + box.h / 2 })
  return { cx: c.x, cy: c.y, w: box.w * t.scale, h: box.h * t.scale }
}

/** `toCanvas` as an SVG `transform` attribute (the preview's group transform). */
export function graphicsSvgTransform(t: GraphicsTransform): string {
  return `translate(${t.x} ${t.y}) scale(${t.scale}) translate(${-GRAPHICS_ORIGIN.x} ${-GRAPHICS_ORIGIN.y})`
}

// --- Timing ------------------------------------------------------------------------

/**
 * How a mark looks `localSec` seconds after its layer's start: null before it
 * appears, else its opacity (a fade's linear ramp) and how much of it is drawn
 * (a draw-on's linear 0→1). Both run over `REVEAL_SEC` from `atSec`.
 */
export function markStateAt(m: Pick<GraphicMark, 'atSec' | 'reveal'>, localSec: number): MarkState | null {
  const t = localSec - m.atSec
  if (t < 0) return null
  const f = Math.min(1, t / REVEAL_SEC)
  if (m.reveal === 'fade') return { opacity: f, progress: 1 }
  if (m.reveal === 'draw') return { opacity: 1, progress: f }
  return { opacity: 1, progress: 1 }
}

export interface MarkState {
  opacity: number
  progress: number
}

/** The export's frame rate (`exporterArgs`: `-r 30`), which a draw-on is sampled at. */
const EXPORT_FPS = 30
/** Frames a whole draw-on export renders: one per output frame across the
 *  reveal, then the finished mark (held to the layer's end). */
export const DRAW_ON_FRAMES = Math.round(REVEAL_SEC * EXPORT_FPS) + 1

/** Seconds of a mark's reveal already past at its tile's start — non-zero only
 *  for a mark whose moment fell before the start (a negative `atSec`). */
export const revealLead = (m: Pick<GraphicMark, 'atSec'>): number => Math.max(0, -m.atSec)

/** How many frames a draw-on export renders: the rest of the reveal from where
 *  the mark first shows (all of it, unless the tile starts mid-reveal), then
 *  the finished mark. 1 = nothing left to draw: a still. */
export function drawOnFrameCount(m: Pick<GraphicMark, 'atSec'>): number {
  const left = REVEAL_SEC - revealLead(m)
  return left > 0 ? Math.ceil(left * EXPORT_FPS - 1e-9) + 1 : 1
}

/** How much of a draw-on mark export frame `i` shows, counted from when the
 *  mark first shows in its tile — the preview's `markStateAt` at that same
 *  instant, so the two trace in step. */
export function drawOnProgress(m: Pick<GraphicMark, 'atSec' | 'reveal'>, i: number): number {
  return markStateAt(m, Math.max(0, m.atSec) + i / EXPORT_FPS)?.progress ?? 0
}

// --- Geometry ----------------------------------------------------------------------

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const lerp = (a: Pt, b: Pt, f: number): Pt => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f })
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The leading `f` (0..1) of a polyline, by length. */
export function polylinePrefix(pts: Pt[], f: number): Pt[] {
  if (pts.length < 2 || f >= 1) return pts
  if (f <= 0) return [pts[0]]
  const lens = pts.slice(1).map((p, i) => dist(pts[i], p))
  let left = lens.reduce((a, b) => a + b, 0) * f
  const out = [pts[0]]
  for (let i = 0; i < lens.length; i++) {
    if (left >= lens[i]) {
      out.push(pts[i + 1])
      left -= lens[i]
      continue
    }
    out.push(lerp(pts[i], pts[i + 1], lens[i] > 0 ? left / lens[i] : 0))
    break
  }
  return out
}

/** The box two opposite corners span. */
function cornerBox(m: GraphicMark): { x: number; y: number; w: number; h: number } {
  const [a, b] = m.points
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/** A rectangle's perimeter clockwise from the top edge, corners rounded by
 *  `radiusPx` (each corner sampled as a short arc). */
function rectOutline(m: GraphicMark): Pt[] {
  const { x, y, w, h } = cornerBox(m)
  const r = clamp(m.radiusPx ?? 0, 0, Math.min(w, h) / 2)
  if (r <= 0) {
    return [
      { x: x + w / 2, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
      { x, y },
      { x: x + w / 2, y }
    ]
  }
  const out: Pt[] = [{ x: x + w / 2, y }]
  const corner = (cx: number, cy: number, from: number): void => {
    for (let k = 0; k <= 8; k++) {
      const a = ((from + (90 * k) / 8) * Math.PI) / 180
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
  }
  corner(x + w - r, y + r, -90)
  corner(x + w - r, y + h - r, 0)
  corner(x + r, y + h - r, 90)
  corner(x + r, y + r, 180)
  out.push({ x: x + w / 2, y })
  return out
}

/** An ellipse inscribed in the box, clockwise from the top, as 96 segments. */
function ellipseOutline(m: GraphicMark): Pt[] {
  const { x, y, w, h } = cornerBox(m)
  const out: Pt[] = []
  for (let k = 0; k <= 96; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / 96
    out.push({ x: x + w / 2 + (w / 2) * Math.cos(a), y: y + h / 2 + (h / 2) * Math.sin(a) })
  }
  return out
}

/** The angle between an angle mark's two arms, in degrees (0..180). */
export function angleDeg(m: Pick<GraphicMark, 'points'>): number {
  const [v, a, b] = m.points
  if (!v || !a || !b) return 0
  const u = sub(a, v)
  const w = sub(b, v)
  const n = Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y)
  if (n === 0) return 0
  return (Math.acos(clamp((u.x * w.x + u.y * w.y) / n, -1, 1)) * 180) / Math.PI
}

/** Arrowhead length for a stroke width (capped so a short arrow keeps a shaft). */
const headLength = (m: GraphicMark): number =>
  Math.min(Math.max(28, m.widthPx * 3.5), dist(m.points[0], m.points[1]) * 0.6)

/** Angle-mark proportions: the arc between the arms and the degree label. */
function angleParts(m: GraphicMark): { radius: number; fontSizePx: number } {
  const [v, a, b] = m.points
  return {
    radius: clamp(0.3 * Math.min(dist(v, a), dist(v, b)), 24, 140),
    fontSizePx: Math.max(40, m.widthPx * 5)
  }
}

/** One drawable piece of a mark, in mark space. Paths are stroked with round
 *  caps and joins. */
export type MarkShape =
  | { kind: 'path'; d: string; stroke: string | null; strokeWidth: number; fill: string | null }
  | {
      kind: 'label'
      x: number
      y: number
      text: string
      fontSizePx: number
      color: string
      outlinePx: number
      /** Equal-width digits, so a changing number doesn't wobble (a workout
       *  readout). Absent = the font's own. */
      tabular?: boolean
    }

const f2 = (n: number): string => (Math.round(n * 100) / 100).toString()
/** An SVG path through `pts` (closed with `close`). */
export const pathD = (pts: Pt[], close = false): string =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${f2(p.x)} ${f2(p.y)}`).join(' ') + (close ? ' Z' : '')

/**
 * A mark as SVG pieces with `progress` (0..1) of it drawn — a draw-on traces
 * strokes first (an arrow's head rides the growing tip; an angle's arc sweeps
 * after its arms) and adds the fill and the degree label once complete.
 */
export function markShapes(m: GraphicMark, progress = 1): MarkShape[] {
  const p = clamp(progress, 0, 1)
  if (p <= 0 || m.points.length < 2) return []
  const stroke = (pts: Pt[], close = false, fill: string | null = null, width = m.widthPx): MarkShape => ({
    kind: 'path',
    d: pathD(pts, close),
    stroke: m.color,
    strokeWidth: width,
    fill
  })
  const [a, b] = m.points
  switch (m.tool) {
    case 'line':
      return [stroke([a, lerp(a, b, p)])]
    case 'arrow': {
      const len = dist(a, b)
      if (len === 0) return []
      const tip = lerp(a, b, p)
      const drawn = len * p
      const head = headLength(m)
      if (drawn <= head) return [stroke([a, tip])]
      const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
      const back = { x: tip.x - dir.x * head, y: tip.y - dir.y * head }
      const half = head * 0.6
      const wing = (side: number): Pt => ({ x: back.x - dir.y * half * side, y: back.y + dir.x * half * side })
      // The shaft stops inside the head so its round cap can't poke past the tip.
      const shaftEnd = { x: tip.x - dir.x * head * 0.7, y: tip.y - dir.y * head * 0.7 }
      return [stroke([a, shaftEnd]), stroke([tip, wing(1), wing(-1)], true, m.color, Math.max(2, m.widthPx * 0.5))]
    }
    case 'rect':
    case 'ellipse': {
      const outline = m.tool === 'rect' ? rectOutline(m) : ellipseOutline(m)
      if (p < 1) return [stroke(polylinePrefix(outline, p))]
      return [stroke(outline, true, m.fill ?? null)]
    }
    case 'angle': {
      const c = m.points[2]
      if (!c) return [stroke([a, lerp(a, b, p)])]
      // Arms draw out from the joint together over the first 60%, then the
      // arc sweeps from arm A to arm B; the label lands with the last frame.
      const armF = clamp(p / 0.6, 0, 1)
      const out: MarkShape[] = [stroke([lerp(a, b, armF), a, lerp(a, c, armF)])]
      const { radius, fontSizePx } = angleParts(m)
      const a0 = Math.atan2(b.y - a.y, b.x - a.x)
      let sweep = Math.atan2(c.y - a.y, c.x - a.x) - a0
      while (sweep > Math.PI) sweep -= 2 * Math.PI
      while (sweep < -Math.PI) sweep += 2 * Math.PI
      const arcF = clamp((p - 0.6) / 0.4, 0, 1)
      if (arcF > 0 && sweep !== 0) {
        const arc: Pt[] = []
        for (let k = 0; k <= 32; k++) {
          const t = a0 + sweep * arcF * (k / 32)
          arc.push({ x: a.x + radius * Math.cos(t), y: a.y + radius * Math.sin(t) })
        }
        out.push(stroke(arc, false, null, Math.max(2, m.widthPx * 0.6)))
      }
      if (p >= 1) {
        const mid = a0 + sweep / 2
        const r = radius + fontSizePx * 0.9
        out.push({
          kind: 'label',
          x: a.x + r * Math.cos(mid),
          y: a.y + r * Math.sin(mid),
          text: `${Math.round(angleDeg(m))}°`,
          fontSizePx,
          color: m.color,
          outlinePx: Math.max(3, fontSizePx * 0.12)
        })
      }
      return out
    }
  }
}

/**
 * Everything a fully drawn mark can paint, in mark space: its points padded by
 * the stroke (plus an arrowhead's wings, an angle's label). The export
 * rasterises each mark at this box, so it must hold all of it.
 */
export function markBounds(m: GraphicMark): { x: number; y: number; w: number; h: number } {
  const pts = [...m.points]
  if (m.tool === 'angle' && m.points.length >= 3) {
    const label = markShapes(m, 1).find((s) => s.kind === 'label')
    if (label && label.kind === 'label') {
      const hw = label.fontSizePx * 1.6
      const hh = label.fontSizePx * 0.8
      pts.push({ x: label.x - hw, y: label.y - hh }, { x: label.x + hw, y: label.y + hh })
    }
  }
  const pad = m.widthPx * 2 + 4 + (m.tool === 'arrow' ? headLength(m) * 0.7 : 0)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
}

// --- SVG markup (the export's page) ------------------------------------------------

/** The face angle labels are set in — one CSS family list for the preview's
 *  SVG and the export's Chromium page alike. */
export const LABEL_FONT_FAMILY = fontCssFamily(DEFAULT_FONT_ID)

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One shape as an SVG element string — the markup the preview's React SVG
 *  produces for the same shape. `fontFamily` is a CSS family list. */
export function shapeSvg(s: MarkShape, fontFamily: string): string {
  if (s.kind === 'path') {
    return (
      `<path d="${s.d}" fill="${s.fill ? escAttr(s.fill) : 'none'}" ` +
      `stroke="${s.stroke ? escAttr(s.stroke) : 'none'}" stroke-width="${f2(s.strokeWidth)}" ` +
      `stroke-linecap="round" stroke-linejoin="round"/>`
    )
  }
  return (
    `<text x="${f2(s.x)}" y="${f2(s.y)}" fill="${escAttr(s.color)}" font-size="${f2(s.fontSizePx)}" ` +
    `font-family="${escAttr(fontFamily)}" text-anchor="middle" dominant-baseline="central" ` +
    (s.tabular ? `style="font-variant-numeric:tabular-nums" ` : '') +
    `stroke="#000000" stroke-width="${f2(s.outlinePx)}" stroke-linejoin="round" paint-order="stroke">` +
    `${escAttr(s.text)}</text>`
  )
}

/**
 * A standalone SVG of one mark at `progress`, framing `box` (mark space) at
 * `pxW`×`pxH` — what the export rasterises for each mark (and each draw-on
 * frame) before compositing it where the layer transform puts that box.
 */
export function markSvg(
  m: GraphicMark,
  progress: number,
  box: { x: number; y: number; w: number; h: number },
  pxW: number,
  pxH: number,
  fontFamily: string
): string {
  return shapesSvg(markShapes(m, progress), box, pxW, pxH, fontFamily)
}

/** A standalone SVG of `shapes`, framing `box` of their space at `pxW`×`pxH`
 *  — what the export's Chromium rasterises (a mark, a pose overlay frame). */
export function shapesSvg(
  shapes: MarkShape[],
  box: { x: number; y: number; w: number; h: number },
  pxW: number,
  pxH: number,
  fontFamily: string
): string {
  const body = shapes.map((s) => shapeSvg(s, fontFamily)).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" ` +
    `viewBox="${f2(box.x)} ${f2(box.y)} ${f2(box.w)} ${f2(box.h)}" preserveAspectRatio="none">${body}</svg>`
  )
}

// --- Making and editing marks ------------------------------------------------------

/** Below this drag distance (logical px) a press is a click: drop a default-sized mark. */
export const CLICK_SLOP = 12

/**
 * A new mark from a press at `a` released at `b` (mark space). A click drops a
 * default-sized one: an arrow pointing AT the click, a line/box/circle centred
 * on it. (Angles are placed point by point — `angleMark`.)
 */
export function newMark(tool: Exclude<GraphicTool, 'angle'>, id: string, a: Pt, b: Pt, atSec: number): GraphicMark {
  const base = { id, tool, color: MARK_DEFAULTS.color, widthPx: MARK_DEFAULTS.widthPx, atSec, reveal: 'pop' as const }
  if (dist(a, b) >= CLICK_SLOP) return { ...base, points: [a, b] }
  switch (tool) {
    case 'arrow':
      return { ...base, points: [{ x: a.x - 180, y: a.y - 180 }, a] }
    case 'line':
      return {
        ...base,
        points: [
          { x: a.x - 150, y: a.y },
          { x: a.x + 150, y: a.y }
        ]
      }
    case 'rect':
      return {
        ...base,
        points: [
          { x: a.x - 160, y: a.y - 110 },
          { x: a.x + 160, y: a.y + 110 }
        ]
      }
    case 'ellipse':
      return {
        ...base,
        points: [
          { x: a.x - 130, y: a.y - 130 },
          { x: a.x + 130, y: a.y + 130 }
        ]
      }
  }
}

/** A new angle mark: the joint and the two limb points. */
export function angleMark(id: string, vertex: Pt, armA: Pt, armB: Pt, atSec: number): GraphicMark {
  return {
    id,
    tool: 'angle',
    points: [vertex, armA, armB],
    color: MARK_DEFAULTS.color,
    widthPx: MARK_DEFAULTS.widthPx,
    atSec,
    reveal: 'pop'
  }
}

/**
 * A tile's marks after its start moves by `shiftSec` (later > 0: a left-edge
 * trim inward, the right half of a split; earlier < 0: a trim outward). Each
 * mark keeps its moment in ABSOLUTE time, so it stays on the frame of the clip
 * it was drawn over. A mark whose moment falls before the new start keeps it as
 * a NEGATIVE `atSec`: it is on screen from the tile's start — mid-reveal if the
 * cut lands inside its fade/draw-on (`markStateAt` continues it) — and
 * extending the tile back out later puts it exactly where it was.
 */
export function shiftMarks(marks: GraphicMark[], shiftSec: number): GraphicMark[] {
  if (shiftSec === 0) return marks
  return marks.map((m) => ({ ...m, atSec: m.atSec - shiftSec }))
}

/** The mark moved by (dx, dy) in mark space. */
export function movedMark(m: GraphicMark, dx: number, dy: number): GraphicMark {
  return { ...m, points: m.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
}

/**
 * The mark with point `i` dragged to `p`. A locked rectangle/ellipse keeps a
 * square box: the dragged corner moves along the diagonal from the opposite one.
 */
export function withMarkPoint(m: GraphicMark, i: number, p: Pt): GraphicMark {
  if (i < 0 || i >= m.points.length) return m
  let next = p
  if (m.lockAspect && (m.tool === 'rect' || m.tool === 'ellipse')) next = squareCorner(m.points[1 - i], p)
  return { ...m, points: m.points.map((q, k) => (k === i ? next : q)) }
}

/** The corner opposite `anchor` that makes a square, toward `p`. */
function squareCorner(anchor: Pt, p: Pt): Pt {
  const side = Math.max(Math.abs(p.x - anchor.x), Math.abs(p.y - anchor.y))
  return { x: anchor.x + side * Math.sign(p.x - anchor.x || 1), y: anchor.y + side * Math.sign(p.y - anchor.y || 1) }
}

/** Turning the lock on squares the box up from its first corner. */
export function withLockAspect(m: GraphicMark, lock: boolean): GraphicMark {
  if (!lock) return { ...m, lockAspect: undefined }
  return { ...m, lockAspect: true, points: [m.points[0], squareCorner(m.points[0], m.points[1])] }
}

/** A short name for a mark in lists ("Arrow", "Angle 42°"; a locked box reads as a square/circle). */
export function markTitle(m: GraphicMark): string {
  if (m.tool === 'angle') return `Angle ${Math.round(angleDeg(m))}°`
  if (m.lockAspect && m.tool === 'rect') return 'Square'
  if (m.lockAspect && m.tool === 'ellipse') return 'Circle'
  return TOOL_INFO[m.tool].label
}
