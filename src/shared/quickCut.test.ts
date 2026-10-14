import { describe, expect, it } from 'vitest'
import {
  cutDisplayNames,
  cutProblem,
  deletePiece,
  isUncut,
  keptSec,
  MIN_CUT_SEC,
  pieceAt,
  playFrom,
  sliceWords,
  splitPieceAt,
  splitPieces,
  trimPieceEdge,
  trimPieces,
  wholeClip
} from './quickCut'

describe('quick cut pieces', () => {
  it('starts as the whole clip, which is "uncut"', () => {
    const p = wholeClip(7.9316)
    expect(p).toEqual([{ inSec: 0, outSec: 7.932 }])
    expect(isUncut(p, 7.9316)).toBe(true)
    expect(isUncut([{ inSec: 0.5, outSec: 7.932 }], 7.9316)).toBe(false)
  })

  it('splits the piece under the playhead, and refuses in a gap or too near an edge', () => {
    const p = splitPieceAt(wholeClip(10), 4)!
    expect(p).toEqual([
      { inSec: 0, outSec: 4 },
      { inSec: 4, outSec: 10 }
    ])
    expect(pieceAt(p, 4)).toBe(1) // a piece owns its start, not its end
    expect(splitPieceAt(p, 4.05)).toBeNull() // < MIN from the piece's start
    expect(splitPieceAt([{ inSec: 2, outSec: 5 }], 1)).toBeNull() // gap
    expect(splitPieceAt([{ inSec: 2, outSec: 5 }], 5)).toBeNull() // end is exclusive
  })

  it('plays only the pieces, jumping the gaps', () => {
    const p = [
      { inSec: 1, outSec: 3 },
      { inSec: 5, outSec: 7 }
    ]
    expect(playFrom(p, 2)).toBe(2)
    expect(playFrom(p, 0)).toBe(1)
    expect(playFrom(p, 3)).toBe(5) // a piece's end is already the gap
    expect(playFrom(p, 7)).toBeNull()
  })

  it('deletes down to one piece, never zero', () => {
    const two = splitPieceAt(wholeClip(10), 4)!
    const one = deletePiece(two, 0)!
    expect(one).toEqual([{ inSec: 4, outSec: 10 }])
    expect(deletePiece(one, 0)).toBeNull()
    expect(deletePiece(two, 5)).toBeNull()
  })

  it('trims an edge, clamped to neighbours, the clip and the minimum length', () => {
    const p = [
      { inSec: 1, outSec: 4 },
      { inSec: 6, outSec: 9 }
    ]
    expect(trimPieceEdge(p, 0, 'in', -3, 10)[0].inSec).toBe(0)
    expect(trimPieceEdge(p, 0, 'out', 8, 10)[0].outSec).toBe(6) // stops at the next piece
    expect(trimPieceEdge(p, 1, 'in', 2, 10)[1].inSec).toBe(4) // stops at the previous piece
    expect(trimPieceEdge(p, 1, 'out', 12, 10)[1].outSec).toBe(10)
    expect(trimPieceEdge(p, 0, 'in', 3.99, 10)[0].inSec).toBe(4 - MIN_CUT_SEC)
    expect(trimPieceEdge(p, 0, 'out', 0, 10)[0].outSec).toBe(1 + MIN_CUT_SEC)
    expect(keptSec(p)).toBe(6)
  })
})

describe('assistant arguments', () => {
  it('trim_clip keeps one window, clamping an end past the clip', () => {
    expect(trimPieces(10, 1.5, 4)).toEqual([{ inSec: 1.5, outSec: 4 }])
    expect(trimPieces(10, 1, 99)).toEqual([{ inSec: 1, outSec: 10 }])
    expect(() => trimPieces(10, 4, 4)).toThrow(/after the start/)
    expect(() => trimPieces(10, -1, 4)).toThrow(/before 0s/)
    expect(() => trimPieces(10, 2, 2.05)).toThrow(/at least/)
  })

  it('split_clip cuts at every time (any order, duplicates ignored)', () => {
    expect(splitPieces(10, [7, 3, 3])).toEqual([
      { inSec: 0, outSec: 3 },
      { inSec: 3, outSec: 7 },
      { inSec: 7, outSec: 10 }
    ])
    expect(() => splitPieces(10, [])).toThrow(/at least one/)
    expect(() => splitPieces(10, [0])).toThrow(/not inside/)
    expect(() => splitPieces(10, [10])).toThrow(/not inside/)
    expect(() => splitPieces(10, [3, 3.05])).toThrow(/Clip 2/)
  })

  it('cutProblem catches overlap, order and bounds', () => {
    expect(cutProblem([], 10)).toMatch(/at least one/)
    expect(cutProblem([{ inSec: 0, outSec: 11 }], 10)).toMatch(/after the clip/)
    expect(
      cutProblem(
        [
          { inSec: 3, outSec: 5 },
          { inSec: 1, outSec: 2 }
        ],
        10
      )
    ).toMatch(/overlap or are out of order/)
    expect(
      cutProblem(
        [
          { inSec: 0, outSec: 3 },
          { inSec: 3, outSec: 10 }
        ],
        10
      )
    ).toBeNull()
  })
})

describe('names and transcripts', () => {
  it('names one cut "(cut)" and several "(cut N)", with the output extension', () => {
    expect(cutDisplayNames('IMG_1593.MOV', 1, 'mp4')).toEqual(['IMG_1593 (cut).mp4'])
    expect(cutDisplayNames('clip.v2.webm', 2, 'webm')).toEqual(['clip.v2 (cut 1).webm', 'clip.v2 (cut 2).webm'])
    expect(cutDisplayNames('noext', 1, 'mp4')).toEqual(['noext (cut).mp4'])
  })

  it('moves words to the piece holding their midpoint, re-timed and clamped', () => {
    const words = [
      { text: 'a', startSec: 0.5, endSec: 0.9 },
      { text: 'b', startSec: 1.9, endSec: 2.3 }, // midpoint 2.1 → second piece, clamped at its start
      { text: 'c', startSec: 2.5, endSec: 2.8 },
      { text: 'd', startSec: 4.8, endSec: 5.4 } // midpoint 5.1 → second piece, clamped at its end
    ]
    expect(sliceWords(words, { inSec: 0, outSec: 2 }).map((w) => w.text)).toEqual(['a'])
    expect(sliceWords(words, { inSec: 2, outSec: 5.2 })).toEqual([
      { text: 'b', startSec: 0, endSec: 0.3 },
      { text: 'c', startSec: 0.5, endSec: 0.8 },
      { text: 'd', startSec: 2.8, endSec: 3.2 }
    ])
  })
})
