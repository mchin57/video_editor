import { describe, it, expect } from 'vitest'
import { buildAlphaProxyArgs, buildProxyArgs, proxyDimensions } from './proxy'
import type { ProbeInfo } from '@shared/media'

function probe(over: Partial<ProbeInfo['video']> & { isHdr?: boolean }): ProbeInfo {
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
    audio: { codec: 'aac', sampleRate: 44100, channels: 2 }
  }
}

describe('proxyDimensions', () => {
  it('caps the longest edge at 1280 and keeps even numbers', () => {
    const d = proxyDimensions(probe({ displayWidth: 1080, displayHeight: 1920 }))
    expect(d.h).toBe(1280)
    expect(d.w).toBe(720)
    expect(d.w % 2).toBe(0)
    expect(d.h % 2).toBe(0)
  })
  it('never upscales small sources', () => {
    const d = proxyDimensions(probe({ displayWidth: 640, displayHeight: 360 }))
    expect(d).toEqual({ w: 640, h: 360 })
  })
})

describe('buildProxyArgs', () => {
  it('uses libx264 + computed scale and includes the input/output', () => {
    const args = buildProxyArgs('in.mov', 'out.mp4', probe({}))
    expect(args).toContain('libx264')
    expect(args.join(' ')).toContain('scale=720:1280')
    expect(args[args.length - 1]).toBe('out.mp4')
    expect(args).toContain('in.mov')
  })
  it('inserts the HDR tonemap chain only for HDR sources, tagged from the probe', () => {
    const sdr = buildProxyArgs('in.mov', 'out.mp4', probe({ isHdr: false })).join(' ')
    const hdr = buildProxyArgs(
      'in.mov',
      'out.mp4',
      probe({ isHdr: true, colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc' })
    ).join(' ')
    expect(sdr).not.toContain('tonemap')
    expect(hdr).toContain('tonemap=tonemap=hable')
    // input characteristics must be set explicitly so zscale has a conversion path
    expect(hdr).toContain('tin=smpte2084')
    expect(hdr).toContain('pin=bt2020')
    expect(hdr).toContain('t=linear')
  })
  it('forces CFR for VFR sources only', () => {
    const cfr = buildProxyArgs('in.mov', 'out.mp4', probe({ isVfr: false })).join(' ')
    const vfr = buildProxyArgs('in.mov', 'out.mp4', probe({ isVfr: true, avgFps: 30 })).join(' ')
    expect(cfr).not.toContain('-fps_mode')
    expect(vfr).toContain('-fps_mode cfr')
  })
  it('drops audio mapping when there is no audio stream', () => {
    const noAudio: ProbeInfo = { ...probe({}), audio: null }
    const args = buildProxyArgs('in.mov', 'out.mp4', noAudio).join(' ')
    expect(args).toContain('-an')
    expect(args).not.toContain('0:a:0')
  })
})

describe('buildAlphaProxyArgs', () => {
  it('encodes a VP9 yuva420p WebM at the proxy scale, keeping the audio as Opus', () => {
    const args = buildAlphaProxyArgs('in.webm', 'out.webm', probe({ displayWidth: 1080, displayHeight: 1920 }))
    const s = args.join(' ')
    expect(s).toContain('libvpx-vp9')
    expect(s).toContain('yuva420p')
    expect(s).toContain('scale=720:1280')
    expect(s).toContain('-map 0:a:0? -c:a libopus -b:a 128k') // a matte carries its segment's audio
    expect(args).not.toContain('-an')
    expect(args[args.length - 1]).toBe('out.webm')
  })
  it('stays silent for a source without audio, and mono-folds a one-sided one', () => {
    const silent = buildAlphaProxyArgs('in.webm', 'out.webm', { ...probe({}), audio: null })
    expect(silent).toContain('-an')
    expect(silent).not.toContain('libopus')
    const oneSided = probe({})
    oneSided.audio = { ...oneSided.audio!, monoFoldChannel: 0 }
    expect(buildAlphaProxyArgs('in.webm', 'out.webm', oneSided).join(' ')).toContain('-map 0:a:0? -af pan=')
  })
  it('forces the libvpx decoder for a VP9-alpha input (native decode drops the alpha)', () => {
    const s = buildAlphaProxyArgs('in.webm', 'out.webm', probe({ codec: 'vp9', hasAlpha: true })).join(' ')
    expect(s).toContain('-c:v libvpx-vp9 -i in.webm')
  })
})
