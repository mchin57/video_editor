/**
 * Edge auto-scroll direction. The one invariant worth pinning is that the zone
 * is a GATE and not a throttle: this used to scale speed with edge proximity, so
 * a drag accelerated as the pointer crept outward. `edgeScrollDir` returning a
 * DIRECTION (never a magnitude) is what keeps the rate flat.
 */
import { describe, it, expect, beforeAll } from 'vitest'

// `startDragWithUndo` pulls in the project store, which transitively imports
// ipc/client — and that destructures window.api at module load. Stub it before
// importing (same pattern as Dock.test.tsx).
let EDGE_SCROLL_SPEED: number
let EDGE_SCROLL_ZONE: number
let edgeScrollDir: (p: number, lo: number, hi: number, zone?: number) => number

beforeAll(async () => {
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => undefined })
  const m = await import('./pointerDrag')
  EDGE_SCROLL_SPEED = m.EDGE_SCROLL_SPEED
  EDGE_SCROLL_ZONE = m.EDGE_SCROLL_ZONE
  edgeScrollDir = m.edgeScrollDir
})

// A container spanning x = 100..500 with the default 40px zone.
const LO = 100
const HI = 500
const dir = (p: number): number => edgeScrollDir(p, LO, HI)

describe('edgeScrollDir', () => {
  it('does not scroll in the middle', () => {
    expect(dir(300)).toBe(0)
    expect(dir(LO + EDGE_SCROLL_ZONE + 1)).toBe(0)
    expect(dir(HI - EDGE_SCROLL_ZONE - 1)).toBe(0)
  })

  it('scrolls toward the start anywhere in the leading zone', () => {
    expect(dir(LO + EDGE_SCROLL_ZONE - 1)).toBe(-1)
    expect(dir(LO + 20)).toBe(-1)
    expect(dir(LO)).toBe(-1)
  })

  it('scrolls toward the end anywhere in the trailing zone', () => {
    expect(dir(HI - EDGE_SCROLL_ZONE + 1)).toBe(1)
    expect(dir(HI - 20)).toBe(1)
    expect(dir(HI)).toBe(1)
  })

  it('keeps scrolling past the edge, at the same rate', () => {
    expect(dir(LO - 500)).toBe(-1)
    expect(dir(HI + 500)).toBe(1)
  })

  it('is CONSTANT across the zone — no proximity ramp', () => {
    // Every position in the leading zone must give the identical velocity.
    const vs = []
    for (let p = LO - 50; p < LO + EDGE_SCROLL_ZONE; p++) vs.push(dir(p) * EDGE_SCROLL_SPEED)
    expect(new Set(vs).size).toBe(1)
    expect(vs[0]).toBe(-EDGE_SCROLL_SPEED)

    const ws = []
    for (let p = HI - EDGE_SCROLL_ZONE + 1; p <= HI + 50; p++) ws.push(dir(p) * EDGE_SCROLL_SPEED)
    expect(new Set(ws).size).toBe(1)
    expect(ws[0]).toBe(EDGE_SCROLL_SPEED)
  })

  it('honours a custom zone width', () => {
    expect(edgeScrollDir(LO + 50, LO, HI, 10)).toBe(0)
    expect(edgeScrollDir(LO + 5, LO, HI, 10)).toBe(-1)
  })

  it('biases to the start when the container is narrower than two zones', () => {
    // Degenerate but reachable (a collapsed pane): pick one direction, don't
    // oscillate. The leading test wins.
    expect(edgeScrollDir(50, 40, 90)).toBe(-1)
  })
})
