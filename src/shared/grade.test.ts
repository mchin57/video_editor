import { describe, expect, it } from 'vitest'
import { applyGrade, gradeCssFilter, gradeCurve, gradeSaturationMatrix } from './grade'
import { NEUTRAL_COLOR } from './project'

const g = (brightness: number, contrast = 1, saturation = 1) => ({ brightness, contrast, saturation })

describe('gradeCssFilter', () => {
  it('is the CSS chain the preview draws (exposure is brightness(1 + b))', () => {
    expect(gradeCssFilter(g(0.2, 1.5, 0.8))).toBe('brightness(1.2) contrast(1.5) saturate(0.8)')
    expect(gradeCssFilter(NEUTRAL_COLOR)).toBe('brightness(1) contrast(1) saturate(1)')
  })
})

describe('gradeCurve / gradeSaturationMatrix', () => {
  it('are null when neutral so nothing is emitted', () => {
    expect(gradeCurve(NEUTRAL_COLOR)).toBeNull()
    expect(gradeSaturationMatrix(1)).toBeNull()
    expect(gradeCurve(g(0, 1, 0.5))).toBeNull()
  })

  it('describes exposure as a gain and contrast as a slope about mid grey', () => {
    expect(gradeCurve(g(0.2, 1.5))).toEqual({ gain: 1.2, contrast: 1.5, offset: -0.25 })
    expect(gradeCurve(g(-1, 0.6))).toEqual({ gain: 0, contrast: 0.6, offset: 0.2 })
  })

  it('is the Filter Effects saturate matrix: rows sum to 1 so greys never move', () => {
    for (const s of [0, 0.5, 1.3, 2]) {
      const m = gradeSaturationMatrix(s)!
      for (const row of [0, 3, 6]) expect(m[row] + m[row + 1] + m[row + 2]).toBeCloseTo(1, 5)
    }
    expect(gradeSaturationMatrix(0)).toEqual([0.213, 0.715, 0.072, 0.213, 0.715, 0.072, 0.213, 0.715, 0.072])
  })
})

/**
 * Pinned to what Chromium 148 (this project's Electron) draws for the real CSS
 * filter, measured through a canvas `ctx.filter` on flat 8-bit colours
 * (FFMPEG-NOTES "Clip grade"). Each row: grade, input RGB, Chromium's output.
 */
const CHROMIUM: [string, ReturnType<typeof g>, [number, number, number], [number, number, number]][] = [
  ['exposure +0.2 multiplies: grey 64', g(0.2), [64, 64, 64], [76, 76, 76]],
  ['exposure +0.2: grey 128', g(0.2), [128, 128, 128], [153, 153, 153]],
  ['exposure +0.2: grey 192', g(0.2), [192, 192, 192], [230, 230, 230]],
  ['exposure +0.2 clips: yellow', g(0.2), [250, 240, 10], [255, 255, 12]],
  ['exposure -0.2: red-orange', g(-0.2), [192, 64, 32], [153, 51, 25]],
  ['contrast 1.5: grey 64', g(0, 1.5), [64, 64, 64], [32, 32, 32]],
  ['contrast 1.5: grey 128 is the pivot', g(0, 1.5), [128, 128, 128], [128, 128, 128]],
  ['contrast 1.5: red-orange', g(0, 1.5), [192, 64, 32], [224, 32, 0]],
  // Chromium's float32 maths lands on 50 where the exact value is 51 (0.2 · 255): within 1 level.
  ['contrast 0.6 lifts black', g(0, 0.6), [0, 0, 0], [50, 50, 50]],
  ['contrast 0.6 lowers white', g(0, 0.6), [255, 255, 255], [204, 204, 204]],
  ['contrast 0.6: blue-ish', g(0, 0.6), [64, 128, 192], [89, 127, 166]],
  ['saturation 1.3: red-orange', g(0, 1, 1.3), [192, 64, 32], [223, 57, 15]],
  ['saturation 1.3: blue-ish', g(0, 1, 1.3), [64, 128, 192], [48, 131, 214]],
  ['saturation 0.5: red-orange', g(0, 1, 0.5), [192, 64, 32], [140, 76, 60]],
  ['saturation 2: blue-ish', g(0, 1, 2), [64, 128, 192], [9, 137, 255]],
  ['saturation leaves greys alone', g(0, 1, 2), [64, 64, 64], [64, 64, 64]],
  ['exposure +0.2, contrast 1.5: grey 64', g(0.2, 1.5), [64, 64, 64], [50, 50, 50]],
  ['exposure +0.2, contrast 1.5: grey 128', g(0.2, 1.5), [128, 128, 128], [165, 165, 165]],
  ['exposure +0.2, contrast 1.5: blue-ish', g(0.2, 1.5), [64, 128, 192], [50, 165, 255]],
  ['all three: red-orange', g(0.2, 1.5, 1.3), [192, 64, 32], [255, 38, 0]],
  ['all three: blue-ish', g(0.2, 1.5, 1.3), [64, 128, 192], [21, 170, 255]],
  ['all three, darker: red-orange', g(-0.3, 0.7, 1.8), [192, 64, 32], [173, 59, 30]],
  ['all three, darker: green', g(-0.3, 0.7, 1.8), [30, 200, 90], [2, 153, 56]],
  // Exposure clamps BEFORE contrast: 255·1.5 would give 254.9 unclamped, Chromium gives 191.
  ['exposure +0.5 then contrast 0.5 clamps in between: white', g(0.5, 0.5), [255, 255, 255], [191, 191, 191]],
  ['exposure +0.5 then contrast 0.5: black', g(0.5, 0.5), [0, 0, 0], [63, 63, 63]],
  // ...and exposure clamps before saturation too.
  ['exposure +0.5 then saturation 2', g(0.5, 1, 2), [64, 128, 192], [16, 208, 255]]
]

describe('values from outside the Inspector’s ranges', () => {
  it('holds saturation at 2 on both sides, so every matrix entry stays inside colorchannelmixer’s −2..2', () => {
    expect(gradeSaturationMatrix(5)).toEqual(gradeSaturationMatrix(2))
    expect(Math.max(...gradeSaturationMatrix(5)!.map(Math.abs))).toBeLessThanOrEqual(2)
    expect(gradeSaturationMatrix(-1)).toEqual(gradeSaturationMatrix(0))
    expect(gradeCssFilter({ brightness: 0, contrast: 1, saturation: 5 })).toBe('brightness(1) contrast(1) saturate(2)')
  })

  it('never writes a negative brightness() (invalid CSS would drop the whole filter)', () => {
    expect(gradeCssFilter({ brightness: -1.5, contrast: 1, saturation: 1 })).toBe(
      'brightness(0) contrast(1) saturate(1)'
    )
    expect(gradeCurve({ brightness: -1.5, contrast: 1, saturation: 1 })!.gain).toBe(0)
  })
})

describe('applyGrade (the reference, pinned to measured Chromium output)', () => {
  it.each(CHROMIUM)('%s', (_name, grade, input, expected) => {
    // Within one level: Chromium's float32 arithmetic can land a level off an exact integer.
    applyGrade(grade, input).forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1))
  })

  it('leaves a neutral grade untouched', () => {
    expect(applyGrade(NEUTRAL_COLOR, [12, 34, 56])).toEqual([12, 34, 56])
  })
})
