import { describe, expect, it } from 'vitest'
import { popoutPlacement, type Box } from './popoutPlacement'

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

// A library card on the left: thumbnail at its left, the ＋ Playhead / × buttons at its right.
const card: Box = { left: 10, top: 300, width: 260, height: 80 }
const thumb: Box = { left: 18, top: 308, width: 36, height: 64 }
const base = { card, thumb, width: 520, height: 560, viewportW: 1600, viewportH: 1000, minTop: 48 }

describe('popoutPlacement', () => {
  it('opens beside the whole card, never over it (its buttons stay clickable)', () => {
    const p = popoutPlacement(base)
    expect(p.onRight).toBe(true)
    expect(p.left).toBeGreaterThanOrEqual(card.left + card.width)
    expect(overlaps({ left: p.left, top: p.top, width: 520, height: 560 }, card)).toBe(false)
  })

  it('never rises above the header, even for a card near the top', () => {
    const high = { ...base, card: { ...card, top: 50 }, thumb: { ...thumb, top: 58 } }
    expect(popoutPlacement(high).top).toBe(48)
  })

  it('flips to the left of the card near the right edge, still clear of it', () => {
    const right: Box = { left: 1300, top: 300, width: 260, height: 80 }
    const p = popoutPlacement({ ...base, card: right, thumb: { ...thumb, left: 1308 } })
    expect(p.onRight).toBe(false)
    expect(p.left + 520).toBeLessThanOrEqual(right.left)
  })

  it('bridges the gap between the card and the pop-out', () => {
    const p = popoutPlacement(base)
    expect(p.bridge.left).toBe(card.left + card.width)
    expect(p.bridge.left + p.bridge.width).toBe(p.left)
  })
})
