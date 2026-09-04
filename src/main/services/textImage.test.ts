import { describe, it, expect } from 'vitest'
import type { NativeImage } from 'electron'
import { normaliseCapture } from './textImage'

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
