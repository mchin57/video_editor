import { describe, it, expect } from 'vitest'
import type { NativeImage } from 'electron'
import { buildHtml, buildLayoutHtml, normaliseCapture } from './textImage'

/** Minimal NativeImage stand-in: this helper only ever asks for the size and
 *  (maybe) resizes, so nothing else needs to exist. */
function img(width: number, height: number): NativeImage {
  const stub = {
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }: { width: number; height: number }) => img(w, h),
    __resized: false
  }
  return stub as unknown as NativeImage
}

describe('normaliseCapture', () => {
  it('passes an exactly-sized capture straight through', () => {
    const src = img(1080, 1920)
    expect(normaliseCapture(src, 1080, 1920)).toBe(src)
  })

  it('scales a uniform HiDPI multiple back down', () => {
    // A 2x display captures at twice the size — same aspect, so it is the whole
    // picture and safe to resize.
    expect(normaliseCapture(img(2160, 3840), 1080, 1920).getSize()).toEqual({
      width: 1080,
      height: 1920
    })
    expect(normaliseCapture(img(1620, 2880), 1080, 1920).getSize()).toEqual({
      width: 1080,
      height: 1920
    })
  })

  it('THROWS on a capture cropped to the display work area', () => {
    // The regression: a 1080x1920 window is clamped to the work area (measured
    // 1080x1032 on a 1920x1080 screen), so the capture is the right WIDTH but
    // short — every overlay below the cut is missing. The old guard compared
    // width only, let this through, and the text vanished from the export with
    // nothing raised. Throwing routes the caller to its flat ASS fallback.
    expect(() => normaliseCapture(img(1080, 1032), 1080, 1920)).toThrow(/1080x1032/)
    expect(() => normaliseCapture(img(1080, 1032), 1080, 1920)).toThrow(/cropped/)
  })

  it('throws on any other mismatched aspect rather than stretching it', () => {
    expect(() => normaliseCapture(img(1080, 600), 1080, 1920)).toThrow()
    expect(() => normaliseCapture(img(500, 1920), 1080, 1920)).toThrow()
    expect(() => normaliseCapture(img(0, 0), 1080, 1920)).toThrow()
  })

  it('tolerates a pixel of rounding on an otherwise uniform scale', () => {
    // Fractional scale factors land a pixel off; that is still the whole frame.
    expect(normaliseCapture(img(1081, 1920), 1080, 1920).getSize()).toEqual({
      width: 1080,
      height: 1920
    })
  })
})

describe('buildHtml — the pill inherits the text metrics', () => {
  const spec = {
    text: 'Sick',
    xCenter: 464,
    yCenter: 1109,
    fontFamily: 'montserrat-extrabold',
    fontSizePx: 108.89,
    color: '#ffffff',
    pill: { enabled: true, color: '#000000ff', padPx: 25.79 },
    wrapWidthPx: 993.6
  }
  /** The declaration block of one CSS rule in the generated page. */
  const css = (html: string, cls: string): string => html.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))?.[1] ?? ''

  it('declares the font on the BOX, not only on the text span', () => {
    // THE regression. The pill is an inline span between .box and .txt, and an
    // inline box's background is sized from ITS OWN font metrics. With the font
    // declared only on .txt, the pill inherited the default 16px and drew a box
    // 52px tall (16 + 2x18 padding, measured) while the glyphs were 108.89px —
    // so the text spilled straight out of its own background.
    const box = css(buildHtml(spec, 1080, 1920, null), 'box')
    expect(box).toContain('font-size:108.89px')
    expect(box).toContain('Montserrat ExtraBold')
    expect(box).toContain('font-weight:normal')
  })

  it('does NOT re-declare font-size on the text span, which would re-break it', () => {
    // A font-size on .txt shadows the inherited one for the glyphs only, putting
    // the pill back on a different size from the text it wraps.
    expect(css(buildHtml(spec, 1080, 1920, null), 'txt')).not.toContain('font-size')
  })

  it('uses the same line-height as the preview (shared TEXT_LINE_HEIGHT)', () => {
    // It sets the line box the pill background is drawn around, so a mismatch is
    // a wrong-height pill and different multi-line spacing.
    expect(css(buildHtml(spec, 1080, 1920, null), 'box')).toContain('line-height:1.25')
  })

  it('still carries the fill on the text span', () => {
    expect(css(buildHtml(spec, 1080, 1920, null), 'txt')).toContain('color:#ffffff')
  })
})

describe('buildHtml — the box wraps like the preview', () => {
  const spec = {
    text: 'a caption near the bottom',
    xCenter: 540,
    yCenter: 1340,
    fontFamily: 'montserrat-extrabold',
    fontSizePx: 64,
    color: '#ffffff',
    pill: { enabled: false, color: '#000000cc', padPx: 18 },
    wrapWidthPx: 993.6
  }
  const box = (s: typeof spec & { widthPx?: number; rotationDeg?: number }): string =>
    buildHtml(s, 1080, 1920, null).match(/\.box\{([^}]*)\}/)![1]

  it('is centred by TRANSFORM, never by left (a left edge caps the shrink-wrap)', () => {
    // The old `left:540px; translate(-50%)` box could only shrink-wrap into the
    // 540px right of its centre, so gradient captions wrapped at half the frame.
    const b = box(spec)
    expect(b).toContain('left:0;top:0')
    expect(b).toContain('transform:translate(calc(540px - 50%),calc(1340px - 50%))')
  })

  it('auto-wraps at the shared frame-relative width, or a fixed width when resized', () => {
    expect(box(spec)).toContain('width:max-content;max-width:993.6px')
    const fixed = box({ ...spec, widthPx: 700 })
    expect(fixed).toContain('width:700px')
    expect(fixed).not.toContain('max-width')
  })

  it('rotates the rendered box but lays out unrotated', () => {
    expect(box({ ...spec, rotationDeg: 8 })).toContain('rotate(8deg)')
    const layout = buildLayoutHtml([{ ...spec, rotationDeg: 8 }], 1080, 1920, null)
    expect(layout).not.toContain('rotate(')
    expect(layout).toContain('data-block="0"')
  })

  it('carries the default legibility shadow, scaled — the raster path had none', () => {
    const txt = buildHtml({ ...spec, decoScale: 2 } as typeof spec, 1080, 1920, null).match(/\.txt\{([^}]*)\}/)![1]
    expect(txt).toContain('text-shadow:0 5.4px 12.96px rgba(0,0,0,0.9), 0 0 6.48px rgba(0,0,0,0.9)')
  })
})
