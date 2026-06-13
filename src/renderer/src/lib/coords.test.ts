import { describe, it, expect } from 'vitest'
import {
  LOGICAL,
  SAFE_ZONES,
  stageScale,
  rectsOverlap,
  intrudesSafeZone,
  clampToCanvas
} from './coords'

describe('coords', () => {
  it('uses a 1080x1920 logical space', () => {
    expect(LOGICAL).toEqual({ width: 1080, height: 1920 })
  })

  it('scales the stage to a container width', () => {
    expect(stageScale(540)).toBe(0.5)
    expect(stageScale(1080)).toBe(1)
  })

  it('detects overlapping rects', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(false)
  })

  it('flags text intruding into the bottom safe zone', () => {
    // A caption sitting at y=1500 is inside the bottom 25% safe zone.
    expect(intrudesSafeZone({ x: 100, y: 1500, w: 800, h: 120 })).toBe(true)
  })

  it('passes text comfortably above the safe zone', () => {
    expect(intrudesSafeZone({ x: 100, y: 600, w: 800, h: 120 })).toBe(false)
  })

  it('flags text touching the right action rail', () => {
    expect(intrudesSafeZone({ x: 1000, y: 600, w: 60, h: 120 })).toBe(true)
  })

  it('clamps a rect within the canvas', () => {
    expect(clampToCanvas({ x: -50, y: 2000, w: 200, h: 100 })).toEqual({
      x: 0,
      y: LOGICAL.height - 100,
      w: 200,
      h: 100
    })
  })

  it('keeps the documented safe-zone geometry', () => {
    expect(SAFE_ZONES.bottom.y).toBe(1440)
    expect(SAFE_ZONES.rightRail.x).toBe(972)
  })
})
