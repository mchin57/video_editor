import { describe, it, expect } from 'vitest'
import {
  clampAnimWindows,
  effectiveTextAnimation,
  splitWords,
  textAnimStateAt,
  typewriterSteps,
  SLIDE_DIST_PX,
  BOUNCE_START_SCALE,
  BOUNCE_OVERSHOOT_SCALE,
  type TextAnimation
} from './textAnim'

const anim = (a: Partial<TextAnimation>): TextAnimation => ({
  in: 'none',
  inSec: 0.3,
  out: 'none',
  outSec: 0.3,
  ...a
})

describe('effectiveTextAnimation', () => {
  it('is null for absent/none animations', () => {
    expect(effectiveTextAnimation({})).toBeNull()
    expect(effectiveTextAnimation({ animation: anim({}) })).toBeNull()
  })
  it('is null for rasterised text (gradient or wrap width)', () => {
    const a = anim({ in: 'fadeIn' })
    expect(effectiveTextAnimation({ animation: a, gradient: { from: '#fff', to: '#000', angle: 0 } })).toBeNull()
    expect(effectiveTextAnimation({ animation: a, widthPx: 400 })).toBeNull()
    expect(effectiveTextAnimation({ animation: a })).toBe(a)
  })
  it('is null for text with colour emoji, which the export rasterises too (#7)', () => {
    const a = anim({ in: 'fadeIn' })
    expect(effectiveTextAnimation({ animation: a, text: 'Hi 🔥' })).toBeNull()
    expect(effectiveTextAnimation({ animation: a, text: 'Hi' })).toBe(a)
  })
})

describe('clampAnimWindows', () => {
  it('passes through when in+out fit the duration', () => {
    expect(clampAnimWindows(anim({ in: 'fadeIn', inSec: 0.3, out: 'fadeOut', outSec: 0.5 }), 3)).toEqual({
      inSec: 0.3,
      outSec: 0.5
    })
  })
  it('scales both proportionally when they exceed it', () => {
    const w = clampAnimWindows(anim({ in: 'fadeIn', inSec: 4, out: 'fadeOut', outSec: 2 }), 3)
    expect(w.inSec).toBeCloseTo(2)
    expect(w.outSec).toBeCloseTo(1)
  })
  it('a "none" side contributes zero', () => {
    expect(clampAnimWindows(anim({ in: 'fadeIn', inSec: 0.3 }), 3).outSec).toBe(0)
  })
})

describe('typewriterSteps', () => {
  it('one step per char for short text, always ending on the full length', () => {
    expect(typewriterSteps(3)).toEqual([1, 2, 3])
  })
  it('chunks long text to stay under the cap', () => {
    const steps = typewriterSteps(200, 60)
    expect(steps.length).toBeLessThanOrEqual(60)
    expect(steps[steps.length - 1]).toBe(200)
  })
  it('empty text → no steps', () => {
    expect(typewriterSteps(0)).toEqual([])
  })
})

describe('textAnimStateAt', () => {
  const start = 10
  const end = 13 // dur 3

  it('idle without an animation', () => {
    expect(textAnimStateAt(null, start, end, 'x', 11)).toEqual({
      opacity: 1,
      dy: 0,
      scale: 1,
      revealChars: null,
      litWords: null
    })
  })

  it('fadeIn ramps opacity linearly over inSec', () => {
    const a = anim({ in: 'fadeIn', inSec: 0.4 })
    expect(textAnimStateAt(a, start, end, 'x', 10).opacity).toBe(0)
    expect(textAnimStateAt(a, start, end, 'x', 10.2).opacity).toBeCloseTo(0.5)
    expect(textAnimStateAt(a, start, end, 'x', 11).opacity).toBe(1)
  })

  it('slideUp comes up from SLIDE_DIST_PX with a matching fade', () => {
    const a = anim({ in: 'slideUp', inSec: 0.4 })
    const s0 = textAnimStateAt(a, start, end, 'x', 10)
    expect(s0.dy).toBe(SLIDE_DIST_PX)
    expect(s0.opacity).toBe(0)
    const mid = textAnimStateAt(a, start, end, 'x', 10.2)
    expect(mid.dy).toBeCloseTo(SLIDE_DIST_PX / 2)
    expect(textAnimStateAt(a, start, end, 'x', 11).dy).toBe(0)
  })

  it('bounce scales 0.3 → 1.1 → 1 across the entrance', () => {
    const a = anim({ in: 'bounce', inSec: 0.5 })
    expect(textAnimStateAt(a, start, end, 'x', 10).scale).toBeCloseTo(BOUNCE_START_SCALE)
    expect(textAnimStateAt(a, start, end, 'x', 10.3).scale).toBeCloseTo(BOUNCE_OVERSHOOT_SCALE)
    expect(textAnimStateAt(a, start, end, 'x', 10.5).scale).toBe(1)
    expect(textAnimStateAt(a, start, end, 'x', 12).scale).toBe(1)
  })

  it('typewriter reveals chars stepwise and finishes at inSec', () => {
    const a = anim({ in: 'typewriter', inSec: 1 })
    const text = 'abcd'
    expect(textAnimStateAt(a, start, end, text, 10.0).revealChars).toBe(1)
    expect(textAnimStateAt(a, start, end, text, 10.3).revealChars).toBe(2)
    expect(textAnimStateAt(a, start, end, text, 10.9).revealChars).toBe(4)
    // After the entrance the overlay is fully revealed (null = all visible).
    expect(textAnimStateAt(a, start, end, text, 11.5).revealChars).toBeNull()
  })

  it('wordHighlight lights words at interval starts across the whole window', () => {
    const a = anim({ in: 'wordHighlight' })
    const text = 'one two three'
    expect(textAnimStateAt(a, start, end, text, 10).litWords).toBe(1)
    expect(textAnimStateAt(a, start, end, text, 11.1).litWords).toBe(2)
    expect(textAnimStateAt(a, start, end, text, 12.9).litWords).toBe(3)
  })

  it('fadeOut dims toward the end; slideDown also moves down', () => {
    const f = anim({ out: 'fadeOut', outSec: 0.5 })
    expect(textAnimStateAt(f, start, end, 'x', 12.75).opacity).toBeCloseTo(0.5)
    const sd = anim({ out: 'slideDown', outSec: 0.5 })
    const s = textAnimStateAt(sd, start, end, 'x', 12.75)
    expect(s.dy).toBeCloseTo(SLIDE_DIST_PX / 2)
    expect(s.opacity).toBeCloseTo(0.5)
  })
})

describe('splitWords', () => {
  it('splits on any whitespace, dropping empties', () => {
    expect(splitWords('  one\ntwo  three ')).toEqual(['one', 'two', 'three'])
  })
})
