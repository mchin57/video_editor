import { describe, it, expect } from 'vitest'
import { FRAME } from './layers'
import { EXPORT_PRESETS } from './formats'
import type { LayoutContent } from './project'
import {
  applyLayoutPreset,
  cellSpan,
  coverCrop,
  FULL_CELL,
  LAYOUT_PRESETS,
  layoutCellRect,
  layoutPreset,
  makeLayoutLayer
} from './layouts'

const W = FRAME.width
const H = FRAME.height

describe('LAYOUT_PRESETS', () => {
  it('ships the documented arrangements with sane cell counts', () => {
    const byId = Object.fromEntries(LAYOUT_PRESETS.map((p) => [p.id, p.rects.length]))
    expect(byId).toEqual({
      'split-lr': 2,
      'split-tb': 2,
      'cols-3': 3,
      'rows-3': 3,
      'big-left': 3,
      'big-right': 3,
      'grid-2x2': 4
    })
  })

  it('every preset stays inside the frame and tiles it exactly (area sums to the frame)', () => {
    for (const p of LAYOUT_PRESETS) {
      let area = 0
      for (const r of p.rects) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6)
        expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6)
        area += r.w * r.h
      }
      expect(area).toBeCloseTo(W * H, 3) // full tiling, no gaps/overlap by area
    }
  })

  it('layoutPreset falls back to the first preset for unknown ids', () => {
    expect(layoutPreset('nope')).toBe(LAYOUT_PRESETS[0])
    expect(layoutPreset('grid-2x2').id).toBe('grid-2x2')
  })
})

describe('layoutCellRect', () => {
  const rect = { x: 0, y: 0, w: W / 2, h: H }
  it('is the identity at the default transform (centered, scale 1)', () => {
    expect(layoutCellRect({ x: W / 2, y: H / 2, scale: 1 }, rect)).toEqual(rect)
  })
  it('scales about the frame center and follows the layer position', () => {
    const r = layoutCellRect({ x: W / 2 + 100, y: H / 2 - 50, scale: 0.5 }, rect)
    expect(r.w).toBe(W / 4)
    expect(r.h).toBe(H / 2)
    // rect's top-left was at (−540, −960) from center → scaled to (−270, −480).
    expect(r.x).toBe(W / 2 + 100 - 270)
    expect(r.y).toBe(H / 2 - 50 - 480)
  })

  describe('in a non-9:16 frame', () => {
    const landscape = EXPORT_PRESETS.landscape.frame // 1920×1080 window at (−420, 420)
    const center = { x: W / 2, y: H / 2, scale: 1 }

    it('stretches the authored rects onto the frame, so a layout fills any aspect', () => {
      expect(layoutCellRect(center, FULL_CELL, landscape)).toEqual(landscape)
      // Split L|R: the left half of the 16:9 frame, not of the 9:16 space.
      expect(layoutCellRect(center, layoutPreset('split-lr').rects[0], landscape)).toEqual({
        x: -420,
        y: 420,
        w: 960,
        h: 1080
      })
    })

    it('still scales about the frame center (= the canonical center)', () => {
      const r = layoutCellRect({ ...center, scale: 0.5 }, FULL_CELL, landscape)
      expect(r).toEqual({ x: W / 2 - 480, y: H / 2 - 270, w: 960, h: 540 })
    })

    it('every preset tiles the square frame exactly', () => {
      const sq = EXPORT_PRESETS.square.frame
      for (const p of LAYOUT_PRESETS) {
        const area = p.rects.reduce((a, rc) => {
          const r = layoutCellRect(center, rc, sq)
          expect(r.x).toBeGreaterThanOrEqual(sq.x - 1e-9)
          expect(r.x + r.w).toBeLessThanOrEqual(sq.x + sq.w + 1e-9)
          return a + r.w * r.h
        }, 0)
        expect(area).toBeCloseTo(sq.w * sq.h, 6)
      }
    })
  })
})

describe('coverCrop', () => {
  it('crops the sides of a wide-of-cell source (16:9 into a half-frame cell)', () => {
    // Cell aspect 540/1920 = 0.28125; source 1920×1080 (1.78) → crop width.
    const c = coverCrop(1920, 1080, 540 / 1920)
    expect(c.h).toBe(1080)
    expect(c.w).toBeCloseTo(1080 * (540 / 1920), 6)
    expect(c.x).toBeCloseTo((1920 - c.w) / 2, 6)
    expect(c.y).toBe(0)
  })
  it('crops top/bottom of a tall-of-cell source', () => {
    // Cell aspect 2 (wide); source 1080×1920 (0.5625) → crop height.
    const c = coverCrop(1080, 1920, 2)
    expect(c.w).toBe(1080)
    expect(c.h).toBeCloseTo(540, 6)
    expect(c.y).toBeCloseTo((1920 - 540) / 2, 6)
    expect(c.x).toBe(0)
  })
  it('is a no-op crop when the aspects already match', () => {
    expect(coverCrop(1000, 500, 2)).toEqual({ x: 0, y: 0, w: 1000, h: 500 })
  })
})

describe('makeLayoutLayer / cellSpan / applyLayoutPreset', () => {
  it('seeds empty, muted cells from the preset rects', () => {
    const l = makeLayoutLayer('L', 'grid-2x2', 2, 5)
    expect(l.startSec).toBe(2)
    expect(l.endSec).toBe(7)
    const c = l.content as LayoutContent
    expect(c.kind).toBe('layout')
    expect(c.cells).toHaveLength(4)
    for (const cell of c.cells) {
      expect(cell.mediaId).toBeNull()
      expect(cell.mute).toBe(true)
      expect(cellSpan(cell)).toBe(0) // empty cells span nothing
    }
    expect(c.cells.map((cell) => cell.rect)).toEqual(layoutPreset('grid-2x2').rects)
  })

  it('cellSpan is the trim span once media is set', () => {
    const l = makeLayoutLayer('L', 'split-lr', 0, 5)
    const c = l.content as LayoutContent
    const cell = { ...c.cells[0], mediaId: 'm', inSec: 1, outSec: 4.5 }
    expect(cellSpan(cell)).toBeCloseTo(3.5, 9)
  })

  it('applyLayoutPreset keeps media/trim/mute by index and reshapes the rects', () => {
    const l = makeLayoutLayer('L', 'grid-2x2', 0, 5)
    let c = l.content as LayoutContent
    c = {
      ...c,
      cells: c.cells.map((cell, i) => (i === 0 ? { ...cell, mediaId: 'm', inSec: 1, outSec: 3, mute: false } : cell))
    }
    const next = applyLayoutPreset(c, 'split-lr')
    expect(next.presetId).toBe('split-lr')
    expect(next.cells).toHaveLength(2)
    expect(next.cells[0]).toMatchObject({ mediaId: 'm', inSec: 1, outSec: 3, mute: false })
    expect(next.cells[0].rect).toEqual(layoutPreset('split-lr').rects[0])
    expect(next.cells[1].mediaId).toBeNull() // the (kept) second grid cell was empty
  })
})
