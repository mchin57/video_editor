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
