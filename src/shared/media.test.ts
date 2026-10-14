import { describe, it, expect } from 'vitest'
import { alphaInputDecoder, DESCRIPTION_MAX, normalizeDescription, pixFmtHasAlpha } from './media'

describe('pixFmtHasAlpha', () => {
  it('recognises the alpha pixel-format families', () => {
    for (const f of ['yuva420p', 'yuva444p10le', 'ya8', 'gbrap', 'rgba', 'bgra', 'argb']) {
      expect(pixFmtHasAlpha(f)).toBe(true)
    }
  })
  it('rejects opaque formats and absent values', () => {
    for (const f of ['yuv420p', 'yuv422p10le', 'nv12', 'rgb24', 'gray', undefined, null, '']) {
      expect(pixFmtHasAlpha(f)).toBe(false)
    }
  })
})

describe('alphaInputDecoder', () => {
  const v = (codec: string, hasAlpha: boolean): { codec: string; hasAlpha: boolean } => ({ codec, hasAlpha })
  it('forces the libvpx decoders for VP8/VP9 alpha (native decode drops the side-band)', () => {
    expect(alphaInputDecoder(v('vp9', true))).toBe('libvpx-vp9')
    expect(alphaInputDecoder(v('vp8', true))).toBe('libvpx')
  })
  it('needs no forcing without alpha, or for codecs whose default decoder carries it', () => {
    expect(alphaInputDecoder(v('vp9', false))).toBeNull()
    expect(alphaInputDecoder(v('prores', true))).toBeNull() // ProRes 4444 decodes alpha natively
    expect(alphaInputDecoder(null)).toBeNull()
    expect(alphaInputDecoder(undefined)).toBeNull()
  })
})

describe('normalizeDescription', () => {
  it('folds Windows line endings, trims the ends and caps the length', () => {
    expect(normalizeDescription('  swim start\r\nwave 2  ')).toBe('swim start\nwave 2')
    expect(normalizeDescription(' \n ')).toBe('')
    expect(normalizeDescription('x'.repeat(DESCRIPTION_MAX + 50))).toHaveLength(DESCRIPTION_MAX)
  })
})
