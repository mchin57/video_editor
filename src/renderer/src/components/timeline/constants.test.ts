/**
 * Where a transition's length grip sits on the tile (#64): centred on the
 * wedge's inner tip, but never inside the trim handle's band at the edge, so a
 * very short wedge keeps a reachable grip and the edge keeps trimming.
 */
import { describe, it, expect } from 'vitest'
import { gripOffsetPx, TRIM_HANDLE_PX } from './constants'

describe('gripOffsetPx', () => {
  it('centres the 6 px grip on the inner tip of the wedge', () => {
    expect(gripOffsetPx(24)).toBe(21)
    expect(gripOffsetPx(100)).toBe(97)
  })

  it('never reaches into the trim handle’s band', () => {
    expect(TRIM_HANDLE_PX).toBe(6)
    for (const w of [0, 3, 6, 9]) expect(gripOffsetPx(w)).toBe(TRIM_HANDLE_PX)
  })
})
