import { describe, it, expect } from 'vitest'
import {
  clipDuration,
  timelineDuration,
  clipStartTimes,
  locate,
  splitClip,
  reorder
} from './timeline'
import type { Clip } from '@shared/project'

function clip(id: string, inSec: number, outSec: number): Clip {
  return { id, mediaId: id, inSec, outSec, crop: null, mute: false, gainDb: 0 }
}

const clips = [clip('a', 0, 4), clip('b', 10, 16), clip('c', 2, 5)] // durations 4, 6, 3 → total 13

describe('durations', () => {
  it('clipDuration is out - in (never negative)', () => {
    expect(clipDuration(clip('x', 2, 5))).toBe(3)
    expect(clipDuration(clip('x', 5, 2))).toBe(0)
  })
  it('timelineDuration sums clip durations', () => {
    expect(timelineDuration(clips)).toBe(13)
  })
  it('clipStartTimes are cumulative offsets', () => {
    expect(clipStartTimes(clips)).toEqual([0, 4, 10])
  })
})

describe('locate', () => {
  it('returns null for empty timeline', () => {
    expect(locate([], 1)).toBeNull()
  })
  it('maps a time inside the first clip', () => {
    const p = locate(clips, 1)
    expect(p?.index).toBe(0)
    expect(p?.sourceTime).toBe(1) // inSec 0 + 1
    expect(p?.localTime).toBe(1)
  })
  it('maps a time inside the second clip to its source time', () => {
    const p = locate(clips, 5) // 1s into clip b (starts at 4); b.inSec = 10
    expect(p?.index).toBe(1)
    expect(p?.sourceTime).toBe(11)
  })
  it('a boundary belongs to the later clip', () => {
    const p = locate(clips, 4)
    expect(p?.index).toBe(1)
    expect(p?.sourceTime).toBe(10)
  })
  it('past the end clamps to the last clip end', () => {
    const p = locate(clips, 999)
    expect(p?.index).toBe(2)
    expect(p?.sourceTime).toBe(5) // c.outSec
  })
})

describe('splitClip', () => {
  const makeId = (): string => 'new'
  it('splits into two clips sharing the source', () => {
    const res = splitClip(clip('a', 0, 4), 1.5, makeId)
    expect(res).not.toBeNull()
    const [left, right] = res!
    expect(left.outSec).toBe(1.5)
    expect(right.inSec).toBe(1.5)
    expect(right.outSec).toBe(4)
    expect(right.id).toBe('new')
    expect(left.id).toBe('a')
  })
  it('refuses to split at an edge', () => {
    expect(splitClip(clip('a', 0, 4), 0, makeId)).toBeNull()
    expect(splitClip(clip('a', 0, 4), 4, makeId)).toBeNull()
  })
})

describe('reorder', () => {
  it('moves an item', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })
  it('is a no-op for invalid/equal indices', () => {
    expect(reorder(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(reorder(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })
})
