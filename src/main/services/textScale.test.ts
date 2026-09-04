import { describe, it, expect } from 'vitest'
import { decorationScale, scaledPill, scaledShadow, scaledStroke } from './textScale'

const pill = { enabled: true, color: '#000000ff', padPx: 18 }

describe('decorationScale', () => {
  it('includes the LAYER scale, not just the output scale', () => {
    // The regression: this returned `outputScale` alone, so a resized overlay
    // kept unscaled decorations while its font grew.
    expect(decorationScale(1.4327570906651463, 1)).toBeCloseTo(1.4327570906651463, 9)
    expect(decorationScale(2, 0.5)).toBe(1)
    expect(decorationScale(1, 1)).toBe(1)
  })

  it('is the same factor the font size uses', () => {
    const layerScale = 1.4327570906651463
    const outputScale = 1440 / 1920
    const fontOut = 76 * layerScale * outputScale
    const padOut = scaledPill(pill, decorationScale(layerScale, outputScale)).padPx
    // THE invariant: pill-to-font proportion is fixed by the document and must
    // survive into the export unchanged, at any layer scale and any preset.
    expect(padOut / fontOut).toBeCloseTo(18 / 76, 9)
  })
})

describe('decoration scalers', () => {
  it('scales pill padding', () => {
    expect(scaledPill(pill, 1.4327570906651463).padPx).toBeCloseTo(25.7896, 4)
    // The pre-fix value, for contrast: 18 unscaled against a 108.9px font.
    expect(scaledPill(pill, 1).padPx).toBe(18)
  })

  it('scales stroke width and keeps the colour', () => {
    expect(scaledStroke({ widthPx: 4, color: '#ff0000' }, 1.5)).toEqual({
      widthPx: 6,
      color: '#ff0000'
    })
  })

  it('scales shadow distance AND blur together', () => {
    expect(scaledShadow({ distancePx: 6, blur: 10, color: '#000' }, 2)).toEqual({
      distancePx: 12,
      blur: 20,
      color: '#000'
    })
  })

  it('passes absent decorations through untouched', () => {
    expect(scaledStroke(null, 2)).toBeNull()
    expect(scaledStroke(undefined, 2)).toBeUndefined()
    expect(scaledShadow(null, 2)).toBeNull()
  })

  it('preserves every non-geometric pill field', () => {
    const out = scaledPill({ enabled: false, color: '#123456', padPx: 10 }, 3)
    expect(out.enabled).toBe(false)
    expect(out.color).toBe('#123456')
    expect(out.padPx).toBe(30)
  })
})
