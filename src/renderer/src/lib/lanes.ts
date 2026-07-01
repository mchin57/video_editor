/**
 * Greedy interval packing for timeline lanes: assign each time-span block to the
 * lowest row whose previous block has already ended, so overlapping blocks stack
 * vertically instead of obscuring each other. Pure + unit-tested.
 */

export interface Span {
  id: string
  startSec: number
  endSec: number
}

/** Map of block id → row index (0-based). */
export function packRows(items: Span[]): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  const rowEnds: number[] = [] // end time of the last block placed in each row
  const rows = new Map<string, number>()
  for (const item of sorted) {
    let row = rowEnds.findIndex((end) => end <= item.startSec + 1e-6)
    if (row === -1) {
      row = rowEnds.length
      rowEnds.push(item.endSec)
    } else {
      rowEnds[row] = item.endSec
    }
    rows.set(item.id, row)
  }
  return rows
}

/** Number of rows needed (at least `min`). */
export function rowCount(rows: Map<string, number>, min = 1): number {
  let max = 0
  for (const r of rows.values()) max = Math.max(max, r + 1)
  return Math.max(min, max)
}

const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

/** Per-lane view preference: a manual height-per-row and/or a collapsed flag.
 *  Persisted (localStorage) so the timeline layout survives reloads. */
export interface LaneViewPref {
  rowH?: number
  collapsed?: boolean
}

/** Vertical geometry of the lane stack, in px. Bundled so the layout math is a
 *  pure function of its inputs (and therefore unit-testable). */
export interface LaneGeometry {
  rulerH: number
  rowH: number
  minRowH: number
  maxRowH: number
  collapsedH: number
  gap: number
  scaleH: number
}

/** One laid-out lane: its input `key`/`label`/`rows` plus resolved vertical box. */
export interface LaneBox<K extends string = string> {
  key: K
  label: string
  rows: number
  top: number
  height: number
  rowH: number
  collapsed: boolean
}

export interface LaneLayout<K extends string = string> {
  lanes: LaneBox<K>[]
  /** Top of the bottom time-scale (i.e. just below the last lane). */
  scaleTop: number
  /** Full stacked height including the ruler and bottom scale. */
  totalH: number
}

/**
 * Stack lanes vertically: each lane is `rows * rowH` tall (its per-lane `rowH`
 * clamped to [min,max]), or a thin `collapsedH` strip when collapsed, separated
 * by `gap`, starting below the ruler. Pure so a refactor can't silently drop the
 * resize/collapse behavior without a test failing. @see docs/TIMELINE.md
 */
export function layoutLanes<K extends string>(
  defs: { key: K; label: string; rows: number }[],
  view: Partial<Record<K, LaneViewPref>>,
  geom: LaneGeometry
): LaneLayout<K> {
  let acc = geom.rulerH
  const lanes = defs.map((d) => {
    const v = view[d.key] ?? {}
    const collapsed = !!v.collapsed
    const rowH = clampN(v.rowH ?? geom.rowH, geom.minRowH, geom.maxRowH)
    const top = acc
    const height = collapsed ? geom.collapsedH : d.rows * rowH
    acc += height + geom.gap
    return { ...d, top, height, rowH, collapsed }
  })
  const scaleTop = acc
  return { lanes, scaleTop, totalH: scaleTop + geom.scaleH }
}

/** New height-per-row for a lane resize: the pointer's vertical delta spread
 *  across the lane's rows, clamped to [min,max]. */
export function resizeRowH(startRowH: number, dyPx: number, rows: number, geom: LaneGeometry): number {
  return clampN(startRowH + dyPx / Math.max(1, rows), geom.minRowH, geom.maxRowH)
}
