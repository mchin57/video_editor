import { describe, it, expect } from 'vitest'
import { speechSegments } from './silence'

describe('speechSegments', () => {
  it('returns the gaps between silences within the clip range', () => {
    const segs = speechSegments([{ start: 2, end: 3 }, { start: 5, end: 6 }], 0, 8)
    expect(segs).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 }
    ])
  })
  it('clips silences to the [in,out] range', () => {
    const segs = speechSegments([{ start: 0, end: 1.5 }, { start: 9, end: 12 }], 1, 10)
    expect(segs).toEqual([{ start: 1.5, end: 9 }])
  })
  it('drops speech bits shorter than the minimum', () => {
    const segs = speechSegments([{ start: 2, end: 3 }], 0, 5, 2.5)
    // [0,2] (2s) dropped, [3,5] (2s) dropped → nothing ≥ 2.5s
    expect(segs).toEqual([])
  })
  it('returns one full segment when there is no silence', () => {
    expect(speechSegments([], 0, 5)).toEqual([{ start: 0, end: 5 }])
  })
})
