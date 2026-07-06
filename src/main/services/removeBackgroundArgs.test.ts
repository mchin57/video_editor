import { describe, it, expect } from 'vitest'
import {
  buildMatteDecodeArgs,
  buildMatteEncodeArgs,
  compositeRgba,
  downsampleRatioFor,
  frameToSrcTensor,
  matteDims
} from './removeBackgroundArgs'

describe('matteDims', () => {
  it('keeps Reel-native size and stays even', () => {
    expect(matteDims(1080, 1920)).toEqual({ w: 1080, h: 1920 })
  })
  it('caps the longest edge and never upscales', () => {
    expect(matteDims(3840, 2160)).toEqual({ w: 1920, h: 1080 })
    expect(matteDims(640, 360)).toEqual({ w: 640, h: 360 })
  })
})

describe('downsampleRatioFor', () => {
  it('targets a ~512px long edge, clamped to [0.25, 1]', () => {
    expect(downsampleRatioFor(1080, 1920)).toBeCloseTo(0.267, 2) // 512/1920
    expect(downsampleRatioFor(200, 200)).toBe(1) // small clip → no downsample
  })
})

describe('buildMatte*Args', () => {
  it('decodes upright rgb24 frames at fps, folding an HDR prefilter when present', () => {
    const s = buildMatteDecodeArgs('in.mov', 1080, 1920, 30).join(' ')
    expect(s).toContain('-vf scale=1080:1920:flags=bicubic')
    expect(s).toContain('-pix_fmt rgb24')
    expect(s).toContain('pipe:1')
    const hdr = buildMatteDecodeArgs('in.mov', 1080, 1920, 30, 'zscaleX').join(' ')
    expect(hdr).toContain('-vf zscaleX,scale=1080:1920:flags=bicubic')
  })
  it('encodes stdin rgba into a VP9 yuva420p WebM', () => {
    const s = buildMatteEncodeArgs('out.webm', 1080, 1920, 30)
    const j = s.join(' ')
    expect(j).toContain('-f rawvideo -pix_fmt rgba -s 1080x1920')
    expect(j).toContain('libvpx-vp9')
    expect(j).toContain('yuva420p')
    expect(s[s.length - 1]).toBe('out.webm')
  })
})

describe('RVM frame tensor round-trip', () => {
  it('packs rgb24 HWC pixels into CHW [0,1] planes', () => {
    // 2 pixels: (255,0,0) then (0,128,255)
    const rgb = new Uint8Array([255, 0, 0, 0, 128, 255])
    const t = frameToSrcTensor(rgb, 2, 1)
    expect(Array.from(t.slice(0, 2))).toEqual([1, 0]) // R plane
    expect(t[2]).toBe(0)
    expect(t[3]).toBeCloseTo(128 / 255, 5) // G plane
    expect(t[4]).toBe(0)
    expect(t[5]).toBe(1) // B plane
  })
  it('composites foreground + alpha into straight-alpha RGBA bytes', () => {
    const fgr = new Float32Array([1, 0, 0, 0.5, 0, 1]) // CHW for 2 px
    const pha = new Float32Array([1, 0]) // px0 opaque, px1 transparent
    const out = compositeRgba(fgr, pha, 2, 1)
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(out.slice(4, 8))).toEqual([0, 128, 255, 0])
  })
})
