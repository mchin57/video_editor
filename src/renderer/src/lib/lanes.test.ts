import { describe, it, expect } from 'vitest'
import { packRows, rowCount, type Span } from './lanes'
import { snap } from './snap'

const s = (id: string, startSec: number, endSec: number): Span => ({ id, startSec, endSec })

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

describe('snap', () => {
  it('snaps to the nearest candidate within threshold', () => {
    expect(snap(2.03, [0, 2, 5], 0.1)).toBe(2)
    expect(snap(4.9, [0, 2, 5], 0.2)).toBe(5)
  })
  it('leaves the value when nothing is close enough', () => {
    expect(snap(3.5, [0, 2, 5], 0.1)).toBe(3.5)
  })
})
