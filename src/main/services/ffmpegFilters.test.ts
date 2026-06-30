import { describe, expect, it } from 'vitest'
import { cropFilter, eqFilter, f3, r } from './ffmpegFilters'

describe('ffmpegFilters', () => {
  it('rounds crop geometry to integer pixels (w:h:x:y order)', () => {
    expect(cropFilter({ x: 10.4, y: 20.6, w: 600.5, h: 1000.2 })).toBe('crop=601:1000:10:21')
  })

  it('builds the eq color filter in brightness:contrast:saturation order', () => {
    expect(eqFilter({ brightness: 0.1, contrast: 1.2, saturation: 0.8 })).toBe(
      'eq=brightness=0.1:contrast=1.2:saturation=0.8'
    )
  })

  it('f3 formats to 3 decimals; r rounds to the nearest int', () => {
    expect(f3(1)).toBe('1.000')
    expect(f3(0.12345)).toBe('0.123')
    expect(r(2.5)).toBe(3)
    expect(r(2.4)).toBe(2)
  })
})
