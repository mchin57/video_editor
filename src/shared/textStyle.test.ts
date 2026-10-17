import { describe, it, expect } from 'vitest'
import {
  assBaselineBelowPos,
  assFontSize,
  assOutlineWidth,
  cssText,
  hasColorEmoji,
  textBoxCss,
  textFillCss,
  textPillCss,
  textWrapWidth,
  TEXT_LINE_HEIGHT,
  usesDefaultShadow,
  type TextDeco
} from './textStyle'

const px = (n: number): string => `${n}px`
const deco = (over: Partial<TextDeco> = {}): TextDeco => ({
  color: '#ffffff',
  pill: { enabled: false, color: '#000000cc', padPx: 18 },
  ...over
})

describe('text block box', () => {
  it('one leading and one wrap width for text AND captions', () => {
    expect(TEXT_LINE_HEIGHT).toBe(1.25)
    expect(textWrapWidth(1080)).toBeCloseTo(993.6, 9)
    expect(textWrapWidth(1920)).toBeCloseTo(1766.4, 9) // frame-relative
  })

  it('auto-wraps as max-content capped at the wrap width, or takes a fixed width', () => {
    const auto = textBoxCss({ fontFamily: 'anton', fontSizePx: 76 }, { wrapWidthPx: 900 }, px)
    expect(auto).toMatchObject({
      fontSize: '76px',
      lineHeight: 1.25,
      width: 'max-content',
      maxWidth: '900px',
      whiteSpace: 'pre-wrap',
      textAlign: 'center'
    })
    const fixed = textBoxCss({ fontFamily: 'anton', fontSizePx: 76 }, { widthPx: 500, wrapWidthPx: 900 }, px)
    expect(fixed.width).toBe('500px')
    expect(fixed.maxWidth).toBeUndefined()
  })
})

describe('text paint', () => {
  it('ignores the outline under a pill (the Inspector: "off while pill on")', () => {
    const s = deco({ stroke: { widthPx: 6, color: '#000000' } })
    expect(textFillCss(s, px).WebkitTextStroke).toBe('6px #000000')
    expect(textFillCss({ ...s, pill: { ...s.pill, enabled: true } }, px).WebkitTextStroke).toBeUndefined()
  })

  it('adds the default legibility shadow only when nothing else separates the text', () => {
    expect(usesDefaultShadow(deco())).toBe(true)
    expect(textFillCss(deco(), px, 2).textShadow).toBe('0 5.4px 12.96px rgba(0,0,0,0.9), 0 0 6.48px rgba(0,0,0,0.9)')
    expect(usesDefaultShadow(deco({ stroke: { widthPx: 4, color: '#000' } }))).toBe(false)
    expect(usesDefaultShadow(deco({ shadow: { distancePx: 3, color: '#000', blur: 0 } }))).toBe(false)
    expect(usesDefaultShadow(deco({ pill: { enabled: true, color: '#000', padPx: 10 } }))).toBe(false)
  })

  it('gradient text: no default shadow, and its shadow is a filter BEHIND the glyphs', () => {
    // A text-shadow paints over a background-clip:text gradient and smears it.
    const g = deco({ gradient: { from: '#ff0000', to: '#0000ff', angle: 90 } })
    expect(usesDefaultShadow(g)).toBe(false)
    expect(textFillCss(g, px).textShadow).toBeUndefined()
    const withShadow = textFillCss({ ...g, shadow: { distancePx: 3, color: '#000000', blur: 2 } }, px)
    expect(withShadow.filter).toBe('drop-shadow(3px 3px 2px #000000)')
    expect(withShadow.textShadow).toBeUndefined()
  })

  it('pill: padded rounded background cloned per line; glyphs paint above it', () => {
    expect(textPillCss({ enabled: true, color: '#000000cc', padPx: 18 }, px)).toMatchObject({
      padding: '18px',
      borderRadius: '11px',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone'
    })
    expect(textFillCss(deco({ pill: { enabled: true, color: '#000', padPx: 18 } }), px).position).toBe('relative')
  })

  it('serialises to inline CSS with vendor prefixes', () => {
    expect(cssText({ WebkitTextStroke: '2px #000', lineHeight: 1.25, paintOrder: 'stroke fill' })).toBe(
      '-webkit-text-stroke:2px #000;line-height:1.25;paint-order:stroke fill'
    )
  })
})

describe('libass corrections', () => {
  it('\\fs = CSS size x (winAscent + winDescent) / unitsPerEm', () => {
    expect(assFontSize('montserrat-extrabold', 76)).toBeCloseTo(118.712, 3) // 76 x 1.562
    expect(assFontSize('bebas-neue', 100)).toBeCloseTo(130, 9)
  })

  it('baseline sits (winAscent - winDescent)/2 below an \\an5 \\pos', () => {
    expect(assBaselineBelowPos('montserrat-extrabold', 100)).toBeCloseTo(32.8, 9) // (1109-453)/2/1000
  })

  it('outline: half the CSS stroke width', () => {
    expect(assOutlineWidth(8)).toBe(4)
  })
})

describe('hasColorEmoji', () => {
  it('finds default-emoji characters, FE0F-made emoji, ZWJ sequences, flags and keycaps', () => {
    for (const t of ['Hi 😀', '🔥', 'love ❤️', '👨‍👩‍👧', '🇺🇸', '1️⃣ drill', '🏊‍♂️ swim'])
      expect(hasColorEmoji(t), t).toBe(true)
  })
  it('leaves plain text and text-presentation symbols on libass', () => {
    for (const t of ['SWIM START', '70.3 IRONMAN', '© 2026', 'Pro™', 'a bare ❤', '#1', '*', ''])
      expect(hasColorEmoji(t), t).toBe(false)
  })
})
