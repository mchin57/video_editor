import { describe, expect, it } from 'vitest'
import { hexToRgb01, isNeutralTint, tintFeColorMatrix, tintMatrix } from './tint'

/** Apply a row-major 3×3 matrix to an RGB triple. */
const apply = (m: number[], rgb: number[]): number[] =>
  [0, 1, 2].map((r) => m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2])

describe('tint', () => {
  it('reads hex colours, short or long, ignoring alpha', () => {
    expect(hexToRgb01('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb01('#f80')).toEqual([1, 136 / 255, 0])
    expect(hexToRgb01('#ff800080')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb01('nope')).toEqual([0, 0, 0])
  })

  it('is neutral at zero strength or when absent', () => {
    expect(isNeutralTint(null)).toBe(true)
    expect(isNeutralTint(undefined)).toBe(true)
    expect(isNeutralTint({ color: '#ff0000', amount: 0 })).toBe(true)
    expect(isNeutralTint({ color: '#ff0000', amount: 0.1 })).toBe(false)
  })

  it('zero strength is the identity; full strength maps every pixel to luma × tint', () => {
    expect(tintMatrix({ color: '#123456', amount: 0 })).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    const m = tintMatrix({ color: '#ffd999', amount: 1 })
    const px = [64 / 255, 128 / 255, 192 / 255]
    const y = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]
    const out = apply(m, px)
    expect(out[0]).toBeCloseTo(y * 1, 5)
    expect(out[1]).toBeCloseTo(y * (0xd9 / 255), 5)
    expect(out[2]).toBeCloseTo(y * (0x99 / 255), 5)
  })

  it('mixes linearly with the original by strength, and keeps white at the tint colour', () => {
    const half = tintMatrix({ color: '#ffd999', amount: 0.5 })
    const white = apply(half, [1, 1, 1])
    expect(white[0]).toBeCloseTo(1, 5)
    expect(white[1]).toBeCloseTo(0.5 + 0.5 * (0xd9 / 255), 5)
    expect(white[2]).toBeCloseTo(0.5 + 0.5 * (0x99 / 255), 5)
    // Out-of-range strengths clamp instead of overshooting.
    expect(tintMatrix({ color: '#ffd999', amount: 3 })).toEqual(tintMatrix({ color: '#ffd999', amount: 1 }))
  })

  it('writes the same RGB rows into the SVG feColorMatrix, alpha untouched', () => {
    const t = { color: '#ffd999', amount: 0.5 }
    const m = tintMatrix(t)
    const v = tintFeColorMatrix(t).split(' ').map(Number)
    expect(v).toHaveLength(20)
    expect([v[0], v[1], v[2], v[5], v[6], v[7], v[10], v[11], v[12]]).toEqual(m)
    expect(v.slice(15)).toEqual([0, 0, 0, 1, 0])
  })
})
