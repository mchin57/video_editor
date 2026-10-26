import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type Layer } from '@shared/project'
import { makeTextLayer, makeWorkoutLayer } from '@shared/layers'
import {
  applyRanges,
  deleteRange,
  rangeAt,
  rangeLocked,
  rangesChanged,
  rangesStillMatch,
  setRangeSpeed,
  splitRangeAt,
  trimRangeEdge,
  workoutTilesOf,
  type WorkoutTile
} from './workoutGraph'

let n = 0
const makeId = (): string => `n${++n}`

/** A whole 600 s ride at 100× from timeline 0: 6 s long. */
const whole = (): WorkoutTile =>
  makeWorkoutLayer('W', 'fit', 0, { inSec: 0, outSec: 600, speed: 100 }, []) as WorkoutTile
const win = (t: WorkoutTile): number[] => [t.startSec, t.endSec, t.content.inSec, t.content.outSec]

describe('the graph window’s edits', () => {
  it('finds the tiles of one recording, in recording order', () => {
    const late = makeWorkoutLayer('late', 'fit', 9, { inSec: 300, outSec: 400, speed: 10 }, [])
    const other = makeWorkoutLayer('o', 'other', 0, { inSec: 0, outSec: 10, speed: 1 }, [])
    const comp = { ...createEmptyComposition(), layers: [late, other, whole()] }
    expect(workoutTilesOf(comp, 'fit').map((t) => t.id)).toEqual(['W', 'late'])
    expect(rangeAt(workoutTilesOf(comp, 'fit'), 350)).toBe(0) // the whole ride covers it first
    expect(rangeAt(workoutTilesOf(comp, 'fit'), 650)).toBe(-1)
  })

  it('splits a range at a ride moment, exactly as S on the timeline would', () => {
    const [a, b] = splitRangeAt([whole()], 0, 150, makeId)!
    expect(win(a)).toEqual([0, 1.5, 0, 150])
    expect(win(b)).toEqual([1.5, 6, 150, 600])
    // Too near an end for two tiles (the shortest is 0.2 s = 20 ride s at 100×).
    expect(splitRangeAt([whole()], 0, 10, makeId)).toBeNull()
  })

  it('trims an end to a ride moment: the tile follows at its speed', () => {
    const [t] = trimRangeEdge([whole()], 0, 'out', 450, 600)
    expect(win(t)).toEqual([0, 4.5, 0, 450])
    const [right] = splitRangeAt([whole()], 0, 150, makeId)!.slice(1)
    const [moved] = trimRangeEdge([right], 0, 'in', 250, 600)
    expect(win(moved)).toEqual([2.5, 6, 250, 600])
    // Never past the recording.
    expect(trimRangeEdge([whole()], 0, 'out', 900, 600)[0].content.outSec).toBe(600)
  })

  it('deletes a range, never the last; sets one range’s speed', () => {
    const halves = splitRangeAt([whole()], 0, 300, makeId)!
    expect(deleteRange(halves, 0)!.map((t) => t.content.inSec)).toEqual([300])
    expect(deleteRange([whole()], 0)).toBeNull()
    const [slow] = setRangeSpeed(halves, 0, 10)
    expect(win(slow)).toEqual([0, 30, 0, 300])
  })

  it('a range linked to a clip is shown but never cut', () => {
    const linked = { ...whole(), linkGroupId: 'g' }
    const other = { ...whole(), id: 'W2' }
    expect(rangeLocked(linked)).toMatch(/Linked to a clip/)
    expect(splitRangeAt([linked], 0, 300, makeId)).toBeNull()
    expect(trimRangeEdge([linked], 0, 'out', 100, 600)[0]).toBe(linked)
    expect(deleteRange([linked, other], 0)).toBeNull()
    expect(setRangeSpeed([linked], 0, 2)[0]).toBe(linked)
  })

  it('Save swaps the ranges in where the tile was in the stack, leaving the rest', () => {
    const under = makeTextLayer('under', 0, 2)
    const over = makeTextLayer('over', 0, 2)
    const w = whole()
    const comp = { ...createEmptyComposition(), layers: [under, w, over] as Layer[] }
    const after = splitRangeAt([w], 0, 300, makeId)!
    expect(rangesChanged([w], after)).toBe(true)
    expect(rangesChanged([w], [w])).toBe(false)
    const saved = applyRanges(comp, [w], after)
    expect(saved.layers.map((l) => l.id)).toEqual(['under', after[0].id, after[1].id, 'over'])
  })

  it('Save leaves the recording’s other tiles where they are in the stack', () => {
    // Two tiles of one recording, apart in the stack, the LATER stretch below.
    const late = makeWorkoutLayer('late', 'fit', 9, { inSec: 300, outSec: 600, speed: 10 }, []) as WorkoutTile
    const early = makeWorkoutLayer('early', 'fit', 0, { inSec: 0, outSec: 300, speed: 10 }, []) as WorkoutTile
    const mid = makeTextLayer('mid', 0, 2)
    const comp = { ...createEmptyComposition(), layers: [late, mid, early] as Layer[] }
    const before = workoutTilesOf(comp, 'fit') // early, late
    // Split the early one: its right half goes straight after it; late stays put.
    const after = splitRangeAt(before, 0, 150, makeId)!
    const saved = applyRanges(comp, before, after)
    expect(saved.layers.map((l) => l.id)).toEqual(['late', 'mid', 'early', after[1].id])
    // A speed change only edits in place.
    const faster = setRangeSpeed(before, 1, 20)
    expect(applyRanges(comp, before, faster).layers.map((l) => l.id)).toEqual(['late', 'mid', 'early'])
    // A deleted tile goes.
    expect(applyRanges(comp, before, deleteRange(before, 0)!).layers.map((l) => l.id)).toEqual(['late', 'mid'])
  })

  it('Save checks the timeline still holds what the window opened with', () => {
    const w = whole()
    const comp = { ...createEmptyComposition(), layers: [w] as Layer[] }
    expect(rangesStillMatch(comp, [w])).toBe(true)
    const moved = { ...comp, layers: [{ ...w, startSec: 2, endSec: 8 }] }
    expect(rangesStillMatch(moved, [w])).toBe(false)
    expect(rangesStillMatch({ ...comp, layers: [] }, [w])).toBe(false)
  })
})
