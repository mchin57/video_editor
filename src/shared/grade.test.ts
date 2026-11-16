import { describe, expect, it } from 'vitest'
import {
  GRADE_TABLE_SIZE,
  applyGrade,
  applyVibrance,
  applyWhiteBalance,
  bakeGradeTable,
  gradePixel255,
  gradeCssFilter,
  gradeCurve,
  gradeSaturationMatrix,
  linearToSrgb,
  lookFunction,
  needsGradeTable,
  srgbToLinear,
  whiteBalanceGains,
  type ColorLook
} from './grade'
import { NEUTRAL_COLOR, hasNewColorControls, isNeutralColor, type ColorAdjust } from './project'
import { n6 as cubeN6, parseCube, tetrahedral, writeCube, type CubeTable } from './cube'
import { tintMatrix } from './tint'

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

// --- The colour table (#105, #55) ------------------------------------------------

/** A 0..1 colour's linear-light luminance (Rec. 709). */
const luminance = (rgb: number[]): number =>
  0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2])
const chroma = (rgb: number[]): number => Math.max(...rgb) - Math.min(...rgb)
const look = (color: Partial<ColorAdjust>): ColorLook => ({ color: { ...NEUTRAL_COLOR, ...color } })
const GREY = [0.5, 0.5, 0.5]

describe('the sRGB transfer tables', () => {
  it('stay within 1e-6 of the exact IEC 61966-2-1 curves (far below an 8-bit level)', () => {
    const dec = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    const enc = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
    let worst = 0
    for (let i = 0; i <= 100_000; i++) {
      const v = i / 100_000
      worst = Math.max(worst, Math.abs(srgbToLinear(v) - dec(v)), Math.abs(linearToSrgb(v) - enc(v)))
    }
    expect(worst).toBeLessThan(1e-6)
    expect(srgbToLinear(1)).toBe(1)
    expect(linearToSrgb(0)).toBe(0)
  })
})

describe('the newer controls at their extremes', () => {
  it('temperature +1 warms a grey (red up, blue down) and −1 cools it, keeping its luminance', () => {
    const warm = lookFunction(look({ temperature: 1 }), null)(GREY)
    const cool = lookFunction(look({ temperature: -1 }), null)(GREY)
    expect(warm[0]).toBeGreaterThan(warm[1])
    expect(warm[1]).toBeGreaterThan(warm[2])
    expect(cool[2]).toBeGreaterThan(cool[1])
    expect(cool[1]).toBeGreaterThan(cool[0])
    expect(luminance(warm)).toBeCloseTo(luminance(GREY), 4)
    expect(luminance(cool)).toBeCloseTo(luminance(GREY), 4)
    // Strong enough to see on a mid grey.
    expect(warm[0] - warm[2]).toBeGreaterThan(0.1)
  })

  it('green / magenta +1 lowers green against red and blue; −1 raises it', () => {
    const magenta = lookFunction(look({ greenMagenta: 1 }), null)(GREY)
    const green = lookFunction(look({ greenMagenta: -1 }), null)(GREY)
    expect(magenta[0]).toBeCloseTo(magenta[2], 6)
    expect(magenta[1]).toBeLessThan(magenta[0] - 0.05)
    expect(green[1]).toBeGreaterThan(green[0] + 0.05)
    expect(luminance(magenta)).toBeCloseTo(luminance(GREY), 4)
  })

  it('white balance clamps (white stays in range) and holds values past ±1 at the ends', () => {
    lookFunction(look({ temperature: 1 }), null)([1, 1, 1]).forEach((v) => expect(v).toBeLessThanOrEqual(1))
    expect(whiteBalanceGains(5, 0)).toEqual(whiteBalanceGains(1, 0))
    expect(whiteBalanceGains(0, -3)).toEqual(whiteBalanceGains(0, -1))
    expect(whiteBalanceGains(0, 0)).toBeNull()
  })

  it('vibrance +1 lifts a dull colour much more than a vivid one, and never moves greys', () => {
    const dull = [0.5, 0.45, 0.4]
    const vivid = [0.9, 0.1, 0.1]
    const f = lookFunction(look({ vibrance: 1 }), null)
    expect(chroma(f(dull)) / chroma(dull)).toBeGreaterThan(1.8)
    expect(chroma(f(vivid)) / chroma(vivid)).toBeLessThan(1.25)
    expect(f([1, 0, 0])).toEqual([1, 0, 0]) // fully saturated: k = 1
    f(GREY).forEach((v) => expect(v).toBeCloseTo(0.5, 9))
  })

  it('vibrance −1 greys a dull colour almost entirely but keeps a vivid one mostly', () => {
    const f = lookFunction(look({ vibrance: -1 }), null)
    expect(chroma(f([0.5, 0.45, 0.4]))).toBeLessThan(0.02)
    expect(chroma(f([0.9, 0.1, 0.1]))).toBeGreaterThan(0.5)
    expect(applyVibrance(-5, [0.9, 0.1, 0.1])).toEqual(applyVibrance(-1, [0.9, 0.1, 0.1]))
  })
})

describe('needsGradeTable', () => {
  const lut = { file: 'a.cube', name: 'A', strength: 1 }
  it('is false for the old three sliders and the wash — they keep the CSS / lutrgb paths', () => {
    expect(needsGradeTable({})).toBe(false)
    expect(needsGradeTable({ color: g(0.2, 1.4, 1.3), tint: { color: '#e8c290', amount: 0.6 } })).toBe(false)
    expect(needsGradeTable({ color: { ...g(0.2), temperature: 0, greenMagenta: 0, vibrance: 0 } })).toBe(false)
    expect(needsGradeTable({ lut: { ...lut, strength: 0 } })).toBe(false)
  })
  it('is true for any newer control or a LUT with some strength', () => {
    expect(needsGradeTable(look({ temperature: 0.1 }))).toBe(true)
    expect(needsGradeTable(look({ greenMagenta: -0.1 }))).toBe(true)
    expect(needsGradeTable(look({ vibrance: 0.5 }))).toBe(true)
    expect(needsGradeTable({ lut })).toBe(true)
    expect(isNeutralColor({ ...NEUTRAL_COLOR, vibrance: 0.2 })).toBe(false)
    expect(hasNewColorControls({ ...NEUTRAL_COLOR, vibrance: 0 })).toBe(false)
  })
})

/** A colour's value in a baked table at 0..1 input (the lookup both sides do). */
const lookup = (t: Float32Array, size: number, rgb: number[]): number[] =>
  tetrahedral(t, size, rgb[0] * (size - 1), rgb[1] * (size - 1), rgb[2] * (size - 1))

describe('bakeGradeTable', () => {
  it('an identity look bakes an identity table that leaves colours alone', () => {
    const t = bakeGradeTable({}, null, 17)
    const want = Float32Array.from(
      Array.from({ length: 17 ** 3 }, (_, i) => [i % 17, Math.floor(i / 17) % 17, Math.floor(i / 289)]).flatMap((c) =>
        c.map((v) => cubeN6(v / 16))
      )
    )
    expect(t.every((v, i) => v === want[i])).toBe(true)
    const big = bakeGradeTable({}, null)
    for (const rgb of [
      [0.2, 0.7, 0.4],
      [0.91, 0.13, 0.55],
      [1, 1, 1]
    ]) {
      lookup(big, GRADE_TABLE_SIZE, rgb).forEach((v, k) => expect(v).toBeCloseTo(rgb[k], 5))
    }
  })

  /** The grades the Chromium table above pins, plus each slider at the Inspector's ends. */
  const OLD = [...new Map(CHROMIUM.map(([, c]) => [JSON.stringify(c), c])).values(), g(0.5, 1.8, 2), g(-0.5, 0.5, 0)]

  it('bakes the OLD sliders with applyGrade’s maths: within 1 level of it at every grid point', () => {
    // 52 points a side put every grid point on an 8-bit value (0, 5, 10 … 255),
    // where applyGrade is defined.
    const size = 52
    for (const c of OLD) {
      const t = bakeGradeTable({ color: c }, null, size)
      let worst = 0
      for (let i = 0; i < size ** 3; i += 3) {
        const rgb = [i % size, Math.floor(i / size) % size, Math.floor(i / size ** 2)].map((v) => v * 5)
        const want = applyGrade(c, rgb as [number, number, number])
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(t[i * 3 + k] * 255 - want[k]))
      }
      expect(worst, JSON.stringify(c)).toBeLessThanOrEqual(1)
    }
  })

  it('and between grid points (the real 65-point table) stays within 3 levels on ordinary grades', () => {
    const colours = [
      ...CHROMIUM.map(([, , input]) => [...input]),
      ...Array.from({ length: 52 }, (_, i) => [i * 5, i * 5, i * 5])
    ]
    for (const c of OLD.slice(0, -2)) {
      const t = bakeGradeTable({ color: c }, null)
      let worst = 0
      for (const rgb of colours) {
        const want = applyGrade(c, rgb as [number, number, number])
        const got = lookup(
          t,
          GRADE_TABLE_SIZE,
          rgb.map((v) => v / 255)
        ).map((v) => Math.floor(v * 255 + 1e-4))
        got.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - want[k]))))
      }
      expect(worst, JSON.stringify(c)).toBeLessThanOrEqual(3)
    }
  })

  it('is the reference steps exactly: gradePixel255, white balance, vibrance, wash, in that order', () => {
    const c: ColorAdjust = { ...g(0.15, 1.3, 1.4), temperature: 0.6, greenMagenta: -0.3, vibrance: 0.5 }
    const wash = { color: '#ffd999', amount: 0.4 }
    const f = lookFunction({ color: c, tint: wash }, null)
    const m = tintMatrix(wash)
    for (const rgb of CHROMIUM.map(([, , input]) => input)) {
      let v = gradePixel255(c, rgb).map((x) => x / 255)
      v = applyWhiteBalance(whiteBalanceGains(0.6, -0.3)!, v)
      v = applyVibrance(0.5, v)
      v = [0, 1, 2].map((r) => Math.min(1, Math.max(0, m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2])))
      expect(f(rgb.map((x) => x / 255))).toEqual(v)
    }
  })

  it('turning a newer control on (at 0) never shifts the old sliders or the wash', () => {
    const base: ColorLook = { color: g(0.2, 1.3, 1.4), tint: { color: '#ffd999', amount: 0.5 } }
    const zeroed: ColorLook = { ...base, color: { ...g(0.2, 1.3, 1.4), temperature: 0, vibrance: 0, greenMagenta: 0 } }
    expect(bakeGradeTable(zeroed, null, 9)).toEqual(bakeGradeTable(base, null, 9))
  })

  it('applies the wash after the grade, as the CSS path does (feColorMatrix after the filters)', () => {
    const wash = { color: '#ffd999', amount: 1 }
    const f = lookFunction({ color: g(0.2), tint: wash }, null)
    const graded = applyGrade(g(0.2), [128, 64, 32]).map((v) => v / 255)
    const m = tintMatrix(wash)
    const want = [0, 1, 2].map((r) => m[r * 3] * graded[0] + m[r * 3 + 1] * graded[1] + m[r * 3 + 2] * graded[2])
    f([128 / 255, 64 / 255, 32 / 255]).forEach((v, k) => expect(v).toBeCloseTo(want[k], 2))
  })

  describe('a LUT at its strength', () => {
    // A warm look: red up, blue down — the sort of thing a real LUT does.
    const size = 9
    const warm: CubeTable = {
      kind: '3d',
      size,
      data: Float32Array.from(
        Array.from({ length: size ** 3 }, (_, i) => {
          const r = (i % size) / (size - 1)
          const gg = (Math.floor(i / size) % size) / (size - 1)
          const b = Math.floor(i / size ** 2) / (size - 1)
          return [Math.min(1, r * 1.2), gg, b * 0.7]
        }).flat()
      ),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1]
    }
    const ref = (strength: number): ColorLook => ({ lut: { file: 'w.cube', name: 'Warm', strength } })

    it('strength 0 is no LUT', () => {
      expect(bakeGradeTable(ref(0), warm, 9)).toEqual(bakeGradeTable({}, null, 9))
    })

    it('strength 1 is the LUT in full; 0.5 is halfway', () => {
      const full = lookFunction(ref(1), warm)([0.5, 0.5, 0.5])
      expect(full[0]).toBeCloseTo(0.6, 6)
      expect(full[2]).toBeCloseTo(0.35, 6)
      const half = lookFunction(ref(0.5), warm)([0.5, 0.5, 0.5])
      expect(half[0]).toBeCloseTo(0.55, 6)
      expect(half[2]).toBeCloseTo(0.425, 6)
    })

    it('comes after the grade (the LUT sees the graded colour)', () => {
      const f = lookFunction({ ...ref(1), color: g(0, 1, 0) }, warm)
      // Saturation 0 turns red-orange to its grey first; the LUT warms that grey.
      const grey = applyGrade(g(0, 1, 0), [192, 64, 32])[0] / 255
      const out = f([192 / 255, 64 / 255, 32 / 255])
      expect(out[1]).toBeCloseTo(grey, 2)
      expect(out[0]).toBeCloseTo(Math.min(1, grey * 1.2), 2)
    })

    it('an unloaded LUT file (null) bakes as no LUT rather than failing', () => {
      expect(bakeGradeTable(ref(1), null, 5)).toEqual(bakeGradeTable({}, null, 5))
    })
  })

  it('holds 6-decimal values, so the written .cube reads back as the very same numbers', () => {
    const t = bakeGradeTable(look({ temperature: 0.37, vibrance: 0.4 }), null, 9)
    const back = parseCube(writeCube(9, t))
    expect(Array.from(back.data)).toEqual(Array.from(t))
  })
})
