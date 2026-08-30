import { describe, expect, it } from 'vitest'
import {
  activeSparkle,
  charAnchor,
  DEFAULT_SPARKLE,
  estimateTextBox,
  MAX_CONCURRENT_SPARKLES,
  MAX_SPARKLES,
  sparkleStateAt,
  sparklesFor,
  type SparkleLayout
} from './sparkle'

const base: SparkleLayout = {
  effect: DEFAULT_SPARKLE,
  text: 'HELLO WORLD',
  fontSizePx: 76,
  durSec: 3
}

describe('sparklesFor — determinism', () => {
  it('gives byte-identical sparkles for identical inputs', () => {
    expect(sparklesFor(base)).toEqual(sparklesFor(base))
  })

  it('reshuffles when the text changes', () => {
    const other = sparklesFor({ ...base, text: 'SOMETHING ELSE' })
    expect(other).not.toEqual(sparklesFor(base))
  })
})

describe('sparklesFor — preview/export parity', () => {
  // The preview computes with a LOGICAL font size and the export with one
  // already scaled to output px. The layouts must stay the same shape, or
  // sparkles land in different places in the burn than on screen.
  it('scales every offset proportionally to the font size', () => {
    const big = sparklesFor({ ...base, fontSizePx: 76 })
    const small = sparklesFor({ ...base, fontSizePx: 38 }) // a 540x960 preset
    expect(small).toHaveLength(big.length)
    small.forEach((s, i) => {
      expect(s.x).toBeCloseTo(big[i].x / 2, 6)
      expect(s.y).toBeCloseTo(big[i].y / 2, 6)
      expect(s.sizePx).toBeCloseTo(big[i].sizePx / 2, 6)
    })
  })

  it('keeps timing and rotation identical across resolutions', () => {
    const big = sparklesFor({ ...base, fontSizePx: 76 })
    const small = sparklesFor({ ...base, fontSizePx: 38 })
    small.forEach((s, i) => {
      expect(s.tSec).toBe(big[i].tSec)
      expect(s.lifeSec).toBe(big[i].lifeSec)
      expect(s.rotDeg).toBe(big[i].rotDeg)
    })
  })
})

describe('sparklesFor — count', () => {
  it('scales with density', () => {
    const sparse = sparklesFor({ ...base, effect: { ...DEFAULT_SPARKLE, density: 1 } })
    const dense = sparklesFor({ ...base, effect: { ...DEFAULT_SPARKLE, density: 9 } })
    expect(dense.length).toBeGreaterThan(sparse.length)
  })

  it('scales with the overlay duration', () => {
    expect(sparklesFor({ ...base, durSec: 8 }).length).toBeGreaterThan(sparklesFor(base).length)
  })

  it('caps a long, dense overlay so the ASS file cannot blow up', () => {
    const many = sparklesFor({
      ...base,
      durSec: 600,
      effect: { ...DEFAULT_SPARKLE, density: 10 }
    })
    expect(many.length).toBe(MAX_SPARKLES)
  })

  it('always emits at least one sparkle, however short the overlay', () => {
    expect(sparklesFor({ ...base, durSec: 0.05 }).length).toBeGreaterThanOrEqual(1)
  })

  it('births stay inside the overlay window', () => {
    for (const s of sparklesFor(base)) {
      expect(s.tSec).toBeGreaterThanOrEqual(0)
      expect(s.tSec).toBeLessThanOrEqual(base.durSec)
    }
  })
})

describe('sparklesFor — typewriter frontier', () => {
  const typed = sparklesFor({ ...base, text: 'ABCDEFGHIJKLMNOP', durSec: 4, typewriterSec: 4 })

  it('tracks the reveal left-to-right instead of scattering', () => {
    const first = typed[0]
    const last = typed[typed.length - 1]
    expect(last.x).toBeGreaterThan(first.x)
  })

  it('scatters instead when there is no typewriter entrance', () => {
    const scattered = sparklesFor({ ...base, text: 'ABCDEFGHIJKLMNOP', durSec: 4 })
    expect(scattered).not.toEqual(typed)
  })
})

describe('sparkleStateAt', () => {
  const s = { tSec: 1, lifeSec: 0.5, x: 0, y: 0, sizePx: 10, rotDeg: 0 }

  it('is invisible before birth and after death', () => {
    expect(sparkleStateAt(s, 0.9).opacity).toBe(0)
    expect(sparkleStateAt(s, 1.6).opacity).toBe(0)
  })

  it('peaks at mid-life so it twinkles rather than cross-fades', () => {
    expect(sparkleStateAt(s, 1.25).opacity).toBeCloseTo(1, 5)
    expect(sparkleStateAt(s, 1.05).opacity).toBeLessThan(1)
    expect(sparkleStateAt(s, 1.45).opacity).toBeLessThan(1)
  })

  it('grows as it brightens', () => {
    expect(sparkleStateAt(s, 1.25).scale).toBeGreaterThan(sparkleStateAt(s, 1.05).scale)
  })
})

describe('text estimation', () => {
  it('grows the box with the longest line and the line count', () => {
    const one = estimateTextBox('AAAA', 100)
    const two = estimateTextBox('AAAA\nBB', 100)
    expect(two.height).toBeGreaterThan(one.height)
    expect(two.width).toBe(one.width) // longest line unchanged
  })

  it('walks charAnchor left to right across a line', () => {
    const a = charAnchor('ABCDEF', 0, 100)
    const b = charAnchor('ABCDEF', 5, 100)
    expect(b.x).toBeGreaterThan(a.x)
    expect(b.y).toBeCloseTo(a.y, 6)
  })

  it('drops charAnchor to the next line past a break', () => {
    const first = charAnchor('AB\nCD', 0, 100)
    const second = charAnchor('AB\nCD', 4, 100)
    expect(second.y).toBeGreaterThan(first.y)
  })
})

describe('activeSparkle', () => {
  it('is off when absent, null, or at zero density', () => {
    expect(activeSparkle(undefined)).toBeNull()
    expect(activeSparkle({ sparkle: null })).toBeNull()
    expect(activeSparkle({ sparkle: { density: 0, color: '#fff' } })).toBeNull()
  })

  it('is on for a real effect', () => {
    expect(activeSparkle({ sparkle: DEFAULT_SPARKLE })).toEqual(DEFAULT_SPARKLE)
  })
})

describe('sparklesFor — how many are actually on screen', () => {
  /** Sparkles visible at time `t` — what the viewer counts, and what the
   *  density control is defined in terms of. */
  const aliveAt = (list: ReturnType<typeof sparklesFor>, t: number): number =>
    list.filter((s) => sparkleStateAt(s, t).opacity > 0).length

  it('shows roughly density x 10 at once, mid-overlay', () => {
    for (const [density, expected] of [
      [2, 20],
      [5, 50],
      [10, 100]
    ] as const) {
      const list = sparklesFor({
        ...base,
        durSec: 4,
        effect: { ...DEFAULT_SPARKLE, density }
      })
      const alive = aliveAt(list, 2)
      // Births are jittered, so allow a generous band around the target.
      expect(alive).toBeGreaterThan(expected * 0.6)
      expect(alive).toBeLessThan(expected * 1.4)
    }
  })

  it('holds that on-screen count steady as the overlay gets longer', () => {
    const short = sparklesFor({ ...base, durSec: 2, effect: { ...DEFAULT_SPARKLE, density: 8 } })
    const long = sparklesFor({ ...base, durSec: 12, effect: { ...DEFAULT_SPARKLE, density: 8 } })
    // Far more sparkles in total, but a similar number visible at any instant.
    expect(long.length).toBeGreaterThan(short.length * 4)
    expect(aliveAt(long, 6)).toBeGreaterThan(aliveAt(short, 1) * 0.6)
    expect(aliveAt(long, 6)).toBeLessThan(aliveAt(short, 1) * 1.4)
  })

  it('never exceeds the concurrent ceiling', () => {
    const list = sparklesFor({
      ...base,
      durSec: 6,
      effect: { ...DEFAULT_SPARKLE, density: 10 }
    })
    for (let t = 0; t <= 6; t += 0.25) {
      expect(aliveAt(list, t)).toBeLessThanOrEqual(MAX_CONCURRENT_SPARKLES * 1.4)
    }
  })
})
