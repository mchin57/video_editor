import { describe, expect, it } from 'vitest'
import { resizeBox } from './layers'
import {
  handleOffset,
  normalizeDeg,
  pointerAngleDeg,
  resizeRotatedBox,
  rotateDragDeg,
  rotateVec,
  rotatedBounds
} from './rotation'

const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6)

describe('normalizeDeg', () => {
  it('folds into (-180, 180]', () => {
    expect(normalizeDeg(0)).toBe(0)
    expect(normalizeDeg(180)).toBe(180)
    expect(normalizeDeg(-180)).toBe(180)
    expect(normalizeDeg(190)).toBe(-170)
    expect(normalizeDeg(-190)).toBe(170)
    expect(normalizeDeg(720 + 30)).toBe(30)
    expect(Object.is(normalizeDeg(-0), 0)).toBe(true)
    expect(Object.is(normalizeDeg(-360), 0)).toBe(true)
  })
})

describe('rotateVec', () => {
  it('turns clockwise in screen space (y down)', () => {
    // +x (right) turned 90° clockwise points down (+y).
    const v = rotateVec(10, 0, 90)
    close(v.x, 0)
    close(v.y, 10)
    // Up (-y) turned 90° clockwise points right: where the rotate handle goes.
    const u = rotateVec(0, -10, 90)
    close(u.x, 10)
    close(u.y, 0)
  })
  it('is exact identity at 0', () => {
    expect(rotateVec(3, 4, 0)).toEqual({ x: 3, y: 4 })
  })
})

describe('rotatedBounds', () => {
  it('matches ffmpeg rotw/roth', () => {
    const b = rotatedBounds(400, 200, 90)
    close(b.w, 200)
    close(b.h, 400)
    const c = rotatedBounds(400, 200, 30)
    close(c.w, 400 * Math.cos(Math.PI / 6) + 200 * 0.5)
    close(c.h, 400 * 0.5 + 200 * Math.cos(Math.PI / 6))
  })
})

describe('pointerAngleDeg', () => {
  it('reads 0 straight up and 90 to the right', () => {
    close(pointerAngleDeg(0, 0, 0, -5), 0)
    close(pointerAngleDeg(0, 0, 5, 0), 90)
    close(Math.abs(pointerAngleDeg(0, 0, 0, 5)), 180)
    close(pointerAngleDeg(0, 0, -5, 0), -90)
  })
})

describe('rotateDragDeg', () => {
  it('is relative to where the drag began (no jump on grab)', () => {
    expect(rotateDragDeg(40, 12, 12)).toBe(40)
    expect(rotateDragDeg(40, 12, 32)).toBe(60)
  })
  it('snaps to right angles when close', () => {
    expect(rotateDragDeg(0, 0, 87)).toBe(90)
    expect(rotateDragDeg(0, 0, 84)).toBe(84)
    expect(rotateDragDeg(10, 0, -12)).toBe(0)
    expect(rotateDragDeg(170, 0, 12)).toBe(180)
  })
  it('steps by 15 with shift', () => {
    expect(rotateDragDeg(0, 0, 22, true)).toBe(15)
    expect(rotateDragDeg(0, 0, 23, true)).toBe(30)
  })
  it('wraps through ±180', () => {
    expect(rotateDragDeg(170, 0, 40)).toBe(-150)
  })
})

describe('resizeRotatedBox', () => {
  const box = { cx: 500, cy: 800, w: 400, h: 200 }
  it('is exactly resizeBox at 0°', () => {
    expect(resizeRotatedBox(box, 'e', 30, 7, false, 0)).toEqual(resizeBox(box, 'e', 30, 7, false))
    expect(resizeRotatedBox(box, 'se', 30, 7, true, 0)).toEqual(resizeBox(box, 'se', 30, 7, true))
  })
  it('stretches along the rotated side and keeps the opposite edge fixed', () => {
    // Rotated 90° clockwise, the box's +x ("e") side points DOWN on screen.
    // Dragging the e handle down 50px grows w by 50; the w edge must not move.
    const r = resizeRotatedBox(box, 'e', 0, 50, false, 90)
    close(r.w, 450)
    close(r.h, 200)
    const wEdgeBefore = handleOffset(box.w, box.h, 'w', 90)
    const wEdgeAfter = handleOffset(r.w, r.h, 'w', 90)
    close(box.cx + wEdgeBefore.x, r.cx + wEdgeAfter.x)
    close(box.cy + wEdgeBefore.y, r.cy + wEdgeAfter.y)
  })
  it('ignores the drag component across the side', () => {
    // Sideways (screen x) motion on a 90°-rotated e handle does not change w.
    const r = resizeRotatedBox(box, 'e', 80, 0, false, 90)
    close(r.w, 400)
  })
  it('keeps the opposite corner fixed for a rotated corner scale', () => {
    const deg = 33
    const r = resizeRotatedBox(box, 'se', 40, 25, true, deg)
    const nwBefore = handleOffset(box.w, box.h, 'nw', deg)
    const nwAfter = handleOffset(r.w, r.h, 'nw', deg)
    close(box.cx + nwBefore.x, r.cx + nwAfter.x)
    close(box.cy + nwBefore.y, r.cy + nwAfter.y)
    close(r.w / r.h, box.w / box.h)
  })
})

describe('handleOffset', () => {
  it('puts the rotate anchor on the rotated top edge', () => {
    // Unrotated: straight above the centre.
    const a = handleOffset(400, 200, 'rot', 0)
    close(a.x, 0)
    close(a.y, -100)
    // 90° clockwise: the top edge now faces right.
    const b = handleOffset(400, 200, 'rot', 90)
    close(b.x, 100)
    close(b.y, 0)
  })
})
