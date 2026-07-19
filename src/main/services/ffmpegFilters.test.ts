import { describe, expect, it } from 'vitest'
import { cropFilter, eqFilter, f3, f6, piecewiseLinearExpr, r, speedRampPlayedExpr } from './ffmpegFilters'

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

  describe('piecewiseLinearExpr', () => {
    it('holds a single point as a constant', () => {
      expect(piecewiseLinearExpr([{ t: 1, v: 100 }])).toBe('100.000')
    })
    it('ramps linearly between two points, holding outside', () => {
      expect(piecewiseLinearExpr([{ t: 1, v: 100 }, { t: 3, v: 300 }])).toBe(
        'if(lt(t,1.000),100.000,if(lt(t,3.000),100.000+200.000*(t-1.000)/2.000,300.000))'
      )
    })
    it('nests additional segments inside-out', () => {
      const e = piecewiseLinearExpr([
        { t: 0, v: 0 },
        { t: 1, v: 10 },
        { t: 2, v: 0 }
      ])
      expect(e).toBe(
        'if(lt(t,0.000),0.000,if(lt(t,1.000),0.000+10.000*(t-0.000)/1.000,if(lt(t,2.000),10.000+-10.000*(t-1.000)/1.000,0.000)))'
      )
    })
    it('sorts unordered points and degrades a zero-span segment to a step', () => {
      const e = piecewiseLinearExpr([{ t: 2, v: 5 }, { t: 2, v: 9 }])
      expect(e).toBe('if(lt(t,2.000),5.000,if(lt(t,2.000),9.000,9.000))')
    })
  })

  describe('speedRampPlayedExpr', () => {
    it('a flat segment integrates as (x-u)/v', () => {
      expect(speedRampPlayedExpr([{ u: 0, v: 2 }, { u: 4, v: 2 }])).toBe(
        'if(lt(T-STARTT,4.000000),0.000000+(T-STARTT-0.000000)/2.000000,2.000000)'
      )
    })
    it('a ramped segment integrates as the log closed form (natural log)', () => {
      // speed 1 → 2 over [0, 4]: m = 0.25, total = ln(2)/0.25 ≈ 2.772589.
      expect(speedRampPlayedExpr([{ u: 0, v: 1 }, { u: 4, v: 2 }])).toBe(
        'if(lt(T-STARTT,4.000000),0.000000+log((1.000000+0.250000*(T-STARTT-0.000000))/1.000000)/0.250000,2.772589)'
      )
    })
    it('chains segments with cumulative constants and holds the total past the end', () => {
      const e = speedRampPlayedExpr([
        { u: 0, v: 1 },
        { u: 2, v: 2 },
        { u: 3, v: 2 }
      ])
      // C1 = ln(2)/0.5 = 1.386294; C2 = C1 + 1/2 = 1.886294 (held after u=3).
      expect(e).toBe(
        'if(lt(T-STARTT,2.000000),0.000000+log((1.000000+0.500000*(T-STARTT-0.000000))/1.000000)/0.500000,' +
          'if(lt(T-STARTT,3.000000),1.386294+(T-STARTT-2.000000)/2.000000,1.886294))'
      )
    })
    it('f6 formats to 6 decimals', () => {
      expect(f6(1 / 3)).toBe('0.333333')
    })
  })
})
