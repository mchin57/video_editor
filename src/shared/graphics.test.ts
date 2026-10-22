import { describe, expect, it } from 'vitest'
import {
  DRAW_ON_FRAMES,
  drawOnFrameCount,
  REVEAL_SEC,
  angleDeg,
  angleMark,
  drawOnProgress,
  fromCanvas,
  graphicsSvgTransform,
  markBounds,
  markShapes,
  markStateAt,
  markSvg,
  markTitle,
  movedMark,
  newMark,
  placedBox,
  polylinePrefix,
  shapeSvg,
  shiftMarks,
  toCanvas,
  withLockAspect,
  withMarkPoint,
  type GraphicMark,
  type MarkShape,
  type Pt
} from './graphics'
import { makeGraphicsLayer } from './layers'

const mark = (over: Partial<GraphicMark>): GraphicMark => ({
  id: 'm',
  tool: 'line',
  points: [
    { x: 100, y: 100 },
    { x: 300, y: 100 }
  ],
  color: '#ff0000',
  widthPx: 8,
  atSec: 0,
  reveal: 'pop',
  ...over
})
const paths = (shapes: MarkShape[]): Extract<MarkShape, { kind: 'path' }>[] =>
  shapes.filter((s): s is Extract<MarkShape, { kind: 'path' }> => s.kind === 'path')
/** The points of a path's `d` ("M x y L x y …"). */
const pointsOf = (d: string): Pt[] =>
  [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))

describe('markStateAt', () => {
  it('hides a mark before its time, then pops / fades / draws it in over REVEAL_SEC', () => {
    expect(markStateAt({ atSec: 1, reveal: 'pop' }, 0.99)).toBeNull()
    expect(markStateAt({ atSec: 1, reveal: 'pop' }, 1)).toEqual({ opacity: 1, progress: 1 })
    const fading = markStateAt({ atSec: 1, reveal: 'fade' }, 1 + REVEAL_SEC / 2)!
    expect(fading.opacity).toBeCloseTo(0.5)
    expect(fading.progress).toBe(1)
    const drawing = markStateAt({ atSec: 1, reveal: 'draw' }, 1 + REVEAL_SEC / 4)!
    expect(drawing.opacity).toBe(1)
    expect(drawing.progress).toBeCloseTo(0.25)
    expect(markStateAt({ atSec: 1, reveal: 'draw' }, 9)).toEqual({ opacity: 1, progress: 1 })
  })

  it('samples the draw-on export frames from the same timing (one per 30fps frame, then the finished mark)', () => {
    expect(DRAW_ON_FRAMES).toBe(13)
    const m = { atSec: 0.5, reveal: 'draw' as const }
    expect(drawOnProgress(m, 0)).toBe(0)
    expect(drawOnProgress(m, 6)).toBeCloseTo(0.5)
    expect(drawOnProgress(m, DRAW_ON_FRAMES - 1)).toBe(1)
    expect(drawOnFrameCount(m)).toBe(DRAW_ON_FRAMES)
  })

  it('a tile that starts mid-reveal exports only the rest of the draw-on, from where it shows', () => {
    // The mark's moment is 0.2s before the tile's start: half drawn at frame 0.
    const m = { atSec: -0.2, reveal: 'draw' as const }
    expect(drawOnProgress(m, 0)).toBeCloseTo(0.5)
    expect(drawOnFrameCount(m)).toBe(7) // 6 frames to finish + the finished mark
    expect(drawOnProgress(m, drawOnFrameCount(m) - 1)).toBe(1)
    // Its reveal long over: a still.
    expect(drawOnFrameCount({ atSec: -3 })).toBe(1)
  })
})

describe('polylinePrefix', () => {
  it('cuts a polyline at a fraction of its length', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ]
    expect(polylinePrefix(pts, 0.25)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 }
    ])
    expect(polylinePrefix(pts, 0.75)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 }
    ])
    expect(polylinePrefix(pts, 1)).toBe(pts)
  })
})

describe('markShapes', () => {
  it('draws nothing at progress 0 and a line out to its tip as it draws on', () => {
    expect(markShapes(mark({}), 0)).toEqual([])
    const [half] = paths(markShapes(mark({}), 0.5))
    expect(pointsOf(half.d)).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 100 }
    ])
  })

  it('gives an arrow a filled head at the tip, riding the tip while it draws', () => {
    const a = mark({ tool: 'arrow' })
    const [shaft, head] = paths(markShapes(a))
    expect(head.fill).toBe('#ff0000')
    expect(pointsOf(head.d)[0]).toEqual({ x: 300, y: 100 })
    // The shaft stops inside the head so its round cap can't poke past the tip.
    expect(Math.max(...pointsOf(shaft.d).map((p) => p.x))).toBeLessThan(300)
    const [, midHead] = paths(markShapes(a, 0.5))
    expect(pointsOf(midHead.d)[0]).toEqual({ x: 200, y: 100 })
  })

  it('closes a rectangle and adds its fill only once fully drawn', () => {
    const r = mark({
      tool: 'rect',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 50 }
      ],
      fill: '#00ff0066'
    })
    const [full] = paths(markShapes(r))
    expect(full.d.endsWith('Z')).toBe(true)
    expect(full.fill).toBe('#00ff0066')
    const [part] = paths(markShapes(r, 0.5))
    expect(part.fill).toBeNull()
    expect(part.d.endsWith('Z')).toBe(false)
  })

  it('traces an ellipse inscribed in its box', () => {
    const e = mark({
      tool: 'ellipse',
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 100 }
      ]
    })
    const pts = pointsOf(paths(markShapes(e))[0].d)
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(0)
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(200)
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(100)
  })

  it('labels an angle with its degrees, after the arms and arc have drawn', () => {
    const m = angleMark('a', { x: 500, y: 500 }, { x: 700, y: 500 }, { x: 500, y: 300 }, 0)
    expect(angleDeg(m)).toBeCloseTo(90)
    const full = markShapes(m)
    const label = full.find((s) => s.kind === 'label')
    expect(label && label.kind === 'label' && label.text).toBe('90°')
    expect(markShapes(m, 0.9).some((s) => s.kind === 'label')).toBe(false)
    expect(markTitle(m)).toBe('Angle 90°')
  })
})

describe('markBounds', () => {
  it('holds every point plus the stroke (and an angle label)', () => {
    const b = markBounds(mark({}))
    expect(b.x).toBeLessThan(100 - 8)
    expect(b.x + b.w).toBeGreaterThan(300 + 8)
    const m = angleMark('a', { x: 500, y: 500 }, { x: 700, y: 500 }, { x: 500, y: 300 }, 0)
    const ab = markBounds(m)
    const label = markShapes(m).find((s) => s.kind === 'label')!
    if (label.kind !== 'label') throw new Error('no label')
    expect(label.x).toBeGreaterThan(ab.x)
    expect(label.x).toBeLessThan(ab.x + ab.w)
    expect(label.y).toBeGreaterThan(ab.y)
  })
})

describe('the layer transform', () => {
  const t = { x: 600, y: 1000, scale: 2 }

  it('is the identity on a new graphics layer', () => {
    const l = makeGraphicsLayer('g', 0, 3)
    expect(toCanvas(l, { x: 123, y: 456 })).toEqual({ x: 123, y: 456 })
  })

  it('moves and zooms about the frame centre, and fromCanvas undoes it', () => {
    const p = { x: 640, y: 1060 }
    expect(toCanvas(t, p)).toEqual({ x: 800, y: 1200 })
    expect(fromCanvas(t, toCanvas(t, p))).toEqual(p)
  })

  it('agrees with the SVG group transform the preview draws through', () => {
    // translate(x y) scale(s) translate(-540 -960), applied right to left.
    const nums = [...graphicsSvgTransform(t).matchAll(/-?[\d.]+/g)].map(Number)
    const [tx, ty, s, ox, oy] = nums
    const p = { x: 640, y: 1060 }
    expect({ x: tx + s * (p.x + ox), y: ty + s * (p.y + oy) }).toEqual(toCanvas(t, p))
  })

  it('places a raster box at the transformed centre, scaled', () => {
    // Box centre (590, 980) is 50/20 px off the frame centre → doubled from (600, 1000).
    expect(placedBox({ x: 540, y: 960, w: 100, h: 40 }, t)).toEqual({ cx: 700, cy: 1040, w: 200, h: 80 })
  })
})

describe('making and editing marks', () => {
  it('a drag spans the drag; a click drops a default-sized mark (an arrow points AT the click)', () => {
    const a = { x: 400, y: 400 }
    expect(newMark('line', 'n', a, { x: 500, y: 450 }, 1.5).points).toEqual([a, { x: 500, y: 450 }])
    expect(newMark('line', 'n', a, a, 1.5).atSec).toBe(1.5)
    expect(newMark('arrow', 'n', a, { x: 403, y: 402 }, 0).points[1]).toEqual(a)
    const box = newMark('rect', 'n', a, a, 0).points
    expect((box[0].x + box[1].x) / 2).toBe(400)
  })

  it('moves every point together', () => {
    expect(movedMark(mark({}), 10, -5).points).toEqual([
      { x: 110, y: 95 },
      { x: 310, y: 95 }
    ])
  })

  it('keeps a locked box square while a corner is dragged', () => {
    const r = withLockAspect(
      mark({
        tool: 'rect',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 40 }
        ]
      }),
      true
    )
    expect(r.points[1]).toEqual({ x: 100, y: 100 })
    expect(markTitle(r)).toBe('Square')
    const dragged = withMarkPoint(r, 1, { x: 30, y: 80 })
    expect(dragged.points[1]).toEqual({ x: 80, y: 80 })
    // Unlocked, the corner goes exactly where it's dragged.
    expect(withMarkPoint(withLockAspect(r, false), 1, { x: 30, y: 80 }).points[1]).toEqual({ x: 30, y: 80 })
  })
})

describe('SVG markup', () => {
  it('escapes colours and the label font into attributes', () => {
    const svg = shapeSvg(
      { kind: 'label', x: 1, y: 2, text: '45°', fontSizePx: 40, color: '#fff', outlinePx: 5 },
      '"Montserrat ExtraBold", sans-serif'
    )
    expect(svg).toContain('font-family="&quot;Montserrat ExtraBold&quot;, sans-serif"')
    expect(svg).toContain('paint-order="stroke"')
  })

  it('frames the mark box at the raster size', () => {
    const svg = markSvg(mark({}), 1, { x: 10, y: 20, w: 300, h: 100 }, 600, 200, 'sans-serif')
    expect(svg).toContain('width="600" height="200" viewBox="10 20 300 100"')
    expect(svg).toContain('<path d="M100 100 L300 100"')
  })
})

describe('shiftMarks', () => {
  const ms = [mark({ id: 'a', atSec: 0.5, reveal: 'fade' }), mark({ id: 'b', atSec: 3, reveal: 'draw' })]

  it('keeps each mark at its absolute moment when the start moves later or earlier', () => {
    // A mark whose moment is now before the start keeps it (negative): on
    // screen from the start, mid-fade if the start lands inside its reveal.
    const shifted = shiftMarks(ms, 0.7)
    expect(shifted[0].atSec).toBeCloseTo(-0.2)
    expect(shifted[1].atSec).toBeCloseTo(2.3)
    expect(shifted.map((m) => m.reveal)).toEqual(['fade', 'draw'])
    expect(markStateAt(shiftMarks(ms, 0.7)[0], 0)!.opacity).toBeCloseTo(0.5)
    expect(shiftMarks(ms, -1).map((m) => m.atSec)).toEqual([1.5, 4])
    expect(shiftMarks(ms, 0)).toBe(ms)
  })
})
