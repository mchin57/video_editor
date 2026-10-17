import { describe, it, expect } from 'vitest'
import { buildThumbnailArgs, thumbDimensions } from './thumbnail'
import type { ProbeInfo } from '@shared/media'

function probe(over: Partial<NonNullable<ProbeInfo['video']>> = {}): ProbeInfo {
  return {
    durationSec: 10,
    container: 'mov',
    video: {
      codec: 'hevc',
      width: 1080,
      height: 1920,
      displayWidth: 1080,
      displayHeight: 1920,
      rotationDeg: 0,
      avgFps: 30,
      rFps: 30,
      isVfr: false,
      pixFmt: 'yuv420p',
      colorTransfer: 'bt709',
      colorPrimaries: 'bt709',
      colorSpace: 'bt709',
      isHdr: false,
      ...over
    },
    audio: null
  }
}

describe('thumbDimensions', () => {
  it('caps long edge at 360, even', () => {
    const d = thumbDimensions(probe())
    expect(d.h).toBe(360)
    expect(d.w).toBe(202)
    expect(d.w % 2).toBe(0)
  })
})

describe('buildThumbnailArgs', () => {
  it('grabs a single frame from the start and scales it', () => {
    const a = buildThumbnailArgs('in.mov', 'out.jpg', probe())
    expect(a.join(' ')).toContain('-ss 0')
    expect(a.join(' ')).toContain('-frames:v 1')
    expect(a.join(' ')).toContain('scale=202:360')
    expect(a[a.length - 1]).toBe('out.jpg')
  })
  it('does not seek a still image (a JPEG loses its only frame to -ss 0)', () => {
    const still = buildThumbnailArgs('in.jpg', 'out.jpg', probe({ codec: 'mjpeg' }), true)
    expect(still).not.toContain('-ss')
    expect(still.join(' ')).toContain('-i in.jpg -map 0:v:0 -frames:v 1')
    // Videos keep their exact command.
    expect(buildThumbnailArgs('in.mov', 'out.jpg', probe())).toEqual(
      buildThumbnailArgs('in.mov', 'out.jpg', probe(), false)
    )
    expect(buildThumbnailArgs('in.mov', 'out.jpg', probe()).join(' ')).toContain('-ss 0 -i in.mov')
  })
  it('tonemaps HDR sources only', () => {
    const sdr = buildThumbnailArgs('in.mov', 'out.jpg', probe({ isHdr: false })).join(' ')
    const hdr = buildThumbnailArgs('in.mov', 'out.jpg', probe({ isHdr: true })).join(' ')
    expect(sdr).not.toContain('tonemap')
    expect(hdr).toContain('tonemap=tonemap=hable')
  })
  it('forces the libvpx decoder for VP9-alpha sources (native decode drops the alpha)', () => {
    const s = buildThumbnailArgs('in.webm', 'out.jpg', probe({ codec: 'vp9', hasAlpha: true })).join(' ')
    expect(s).toContain('-c:v libvpx-vp9 -ss 0 -i in.webm')
    const plain = buildThumbnailArgs('in.mov', 'out.jpg', probe()).join(' ')
    expect(plain).not.toContain('-c:v')
  })
})
