import { describe, it, expect } from 'vitest'
import { layoutLanes, packRows, resizeRowH, rowCount, type LaneGeometry, type Span } from './lanes'
import { snap } from './snap'

const s = (id: string, startSec: number, endSec: number): Span => ({ id, startSec, endSec })

// Mirrors the real timeline constants (Timeline.tsx LANE_GEOM).
const GEOM: LaneGeometry = {
  rulerH: 20,
  rowH: 26,
  minRowH: 16,
  maxRowH: 60,
  collapsedH: 14,
  gap: 4,
  scaleH: 18
}
const clips = { key: 'clips' as const, label: 'Clips', rows: 1 }
const audio = { key: 'audio' as const, label: 'Audio', rows: 2 }

describe('packRows', () => {
  it('keeps non-overlapping blocks on row 0', () => {
    const rows = packRows([s('a', 0, 1), s('b', 1, 2), s('c', 2, 3)])
    expect([...rows.values()]).toEqual([0, 0, 0])
    expect(rowCount(rows)).toBe(1)
  })
  it('stacks overlapping blocks onto new rows', () => {
    const rows = packRows([s('a', 0, 3), s('b', 1, 2), s('c', 1.5, 4)])
    expect(rows.get('a')).toBe(0)
    expect(rows.get('b')).toBe(1)
    expect(rows.get('c')).toBe(2)
    expect(rowCount(rows)).toBe(3)
  })
  it('reuses a freed row once a block ends', () => {
    const rows = packRows([s('a', 0, 1), s('b', 0, 2), s('c', 1.2, 3)])
    expect(rows.get('c')).toBe(0) // row 0 freed at t=1, c starts at 1.2
    expect(rowCount(rows)).toBe(2)
  })
})

describe('layoutLanes', () => {
  it('stacks lanes at natural height (rows * rowH) below the ruler, with gaps', () => {
    const { lanes, scaleTop, totalH } = layoutLanes([clips, audio], {}, GEOM)
    expect(lanes[0]).toMatchObject({ key: 'clips', top: 20, height: 26, rowH: 26, collapsed: false })
    // audio starts after clips (26) + gap (4) = 50; two rows tall.
    expect(lanes[1]).toMatchObject({ key: 'audio', top: 50, height: 52 })
    expect(scaleTop).toBe(106) // 50 + 52 + 4
    expect(totalH).toBe(124) // scaleTop + scaleH
  })

  it('resizes a lane by its per-row height and scales the rows with it', () => {
    const { lanes } = layoutLanes([audio], { audio: { rowH: 40 } }, GEOM)
    expect(lanes[0]).toMatchObject({ rowH: 40, height: 80 }) // 2 rows * 40
  })

  it('clamps a lane rowH to [minRowH, maxRowH]', () => {
    expect(layoutLanes([clips], { clips: { rowH: 1000 } }, GEOM).lanes[0].rowH).toBe(60)
    expect(layoutLanes([clips], { clips: { rowH: 1 } }, GEOM).lanes[0].rowH).toBe(16)
  })

  it('collapses a lane to a thin strip, ignoring its rowH for height', () => {
    const { lanes } = layoutLanes([clips, audio], { clips: { collapsed: true, rowH: 50 } }, GEOM)
    expect(lanes[0]).toMatchObject({ collapsed: true, height: 14 })
    // The next lane packs up against the collapsed strip: 20 + 14 + 4 = 38.
    expect(lanes[1].top).toBe(38)
  })

  it('shrinks the total height when a lane collapses', () => {
    const open = layoutLanes([clips, audio], {}, GEOM).totalH
    const collapsed = layoutLanes([clips, audio], { audio: { collapsed: true } }, GEOM).totalH
    expect(collapsed).toBeLessThan(open)
  })
})

describe('resizeRowH', () => {
  it('adds the pointer delta to the starting height for a single-row lane', () => {
    expect(resizeRowH(26, 20, 1, GEOM)).toBe(46)
  })
  it('spreads the delta across the lane rows', () => {
    expect(resizeRowH(26, 20, 2, GEOM)).toBe(36) // 26 + 20/2
  })
  it('clamps to the geometry bounds', () => {
    expect(resizeRowH(50, 100, 1, GEOM)).toBe(60)
    expect(resizeRowH(20, -50, 1, GEOM)).toBe(16)
  })
  it('treats a zero-row lane as one row (no divide-by-zero)', () => {
    expect(resizeRowH(26, 20, 0, GEOM)).toBe(46)
  })
})

describe('snap', () => {
  it('snaps to the nearest candidate within threshold', () => {
    expect(snap(2.03, [0, 2, 5], 0.1)).toBe(2)
    expect(snap(4.9, [0, 2, 5], 0.2)).toBe(5)
  })
  it('leaves the value when nothing is close enough', () => {
    expect(snap(3.5, [0, 2, 5], 0.1)).toBe(3.5)
  })
})
