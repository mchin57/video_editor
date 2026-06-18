import { describe, it, expect } from 'vitest'
import { buildNormalizeArgs, buildFinalArgs, targetForPreset, type ImageOverlayArg } from './exporterArgs'
import type { Clip } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import type { FfmpegCapabilities } from '@shared/ffmpeg'

function asset(over: Partial<MediaAsset['probe']['video']> & { hasAudio?: boolean } = {}): MediaAsset {
  const { hasAudio = true, ...vid } = over
  return {
    id: 'abc',
    fileName: 'clip.mov',
    originalPath: 'C:/vids/clip.mov',
    importedAt: '',
    proxyReady: true,
    transcribed: false,
    probe: {
      durationSec: 20,
      container: 'mov',
      video: {
        codec: 'hevc',
        width: 1920,
        height: 1080,
        displayWidth: 1920,
        displayHeight: 1080,
        rotationDeg: 0,
        avgFps: 30,
        rFps: 30,
        isVfr: false,
        pixFmt: 'yuv420p',
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709',
        colorSpace: 'bt709',
        isHdr: false,
        ...vid
      },
      audio: hasAudio ? { codec: 'aac', sampleRate: 48000, channels: 2 } : null
    }
  }
}

function clip(over: Partial<Clip> = {}): Clip {
  return { id: 'c1', mediaId: 'abc', inSec: 2, outSec: 7, crop: null, mute: false, gainDb: 0, ...over }
}

const target = targetForPreset('reel')

describe('targetForPreset', () => {
  it('reel is 1080x1920', () => {
    expect(target).toEqual({ width: 1080, height: 1920 })
  })
})

describe('buildNormalizeArgs', () => {
  it('trims with accurate seek + duration', () => {
    const a = buildNormalizeArgs(clip(), asset(), target, 'seg.mov')
    const s = a.join(' ')
    expect(s).toContain('-ss 2.000')
    expect(s).toContain('-t 5.000')
    expect(a[a.length - 1]).toBe('seg.mov')
  })
  it('uncropped → fit + pad to target (letterbox), no crop filter', () => {
    const s = buildNormalizeArgs(clip(), asset(), target, 'seg.mov').join(' ')
    expect(s).toContain('force_original_aspect_ratio=decrease')
    expect(s).toContain('pad=1080:1920')
    expect(s).not.toContain('crop=')
  })
  it('cropped → crop then scale-fill', () => {
    const s = buildNormalizeArgs(
      clip({ crop: { x: 100, y: 0, w: 608, h: 1080 } }),
      asset(),
      target,
      'seg.mov'
    ).join(' ')
    expect(s).toContain('crop=608:1080:100:0')
    expect(s).toContain('scale=1080:1920')
    expect(s).not.toContain('pad=')
  })
  it('tonemaps HDR sources only', () => {
    expect(buildNormalizeArgs(clip(), asset({ isHdr: false }), target, 's.mov').join(' ')).not.toContain('tonemap')
    expect(
      buildNormalizeArgs(clip(), asset({ isHdr: true, colorTransfer: 'smpte2084' }), target, 's.mov').join(' ')
    ).toContain('tonemap=tonemap=hable')
  })
  it('maps real audio with gain when unmuted', () => {
    const s = buildNormalizeArgs(clip({ gainDb: -6 }), asset(), target, 's.mov').join(' ')
    expect(s).toContain('-map 0:a:0?')
    expect(s).toContain('volume=-6dB')
  })
  it('uses synthesized silence when muted or no audio', () => {
    const muted = buildNormalizeArgs(clip({ mute: true }), asset(), target, 's.mov').join(' ')
    expect(muted).toContain('anullsrc')
    expect(muted).toContain('-map 1:a:0')
    const noAudio = buildNormalizeArgs(clip(), asset({ hasAudio: false }), target, 's.mov').join(' ')
    expect(noAudio).toContain('-map 1:a:0')
  })
})

describe('buildFinalArgs', () => {
  const caps = (nvenc: boolean): FfmpegCapabilities =>
    ({ encoders: { h264_nvenc: nvenc } } as unknown as FfmpegCapabilities)

  it('uses NVENC when available and preferred', () => {
    const s = buildFinalArgs('list.txt', 'out.mp4', caps(true), { preferNvenc: true }).join(' ')
    expect(s).toContain('h264_nvenc')
    expect(s).toContain('-f concat')
    expect(s).toContain('aac')
  })
  it('falls back to libx264 when NVENC missing or not preferred', () => {
    expect(buildFinalArgs('l', 'o', caps(false), { preferNvenc: true }).join(' ')).toContain('libx264')
    expect(buildFinalArgs('l', 'o', caps(true), { preferNvenc: false }).join(' ')).toContain('libx264')
  })

  const img = (over: Partial<ImageOverlayArg> = {}): ImageOverlayArg => ({
    path: 'C:/m/logo/image.png',
    x: 540,
    y: 960,
    w: 200,
    h: 100,
    startSec: 1,
    endSec: 4,
    opacity: 1,
    anchor: 'center',
    ...over
  })

  it('composites an image overlay: input, scale, time-gated overlay, centered position', () => {
    const args = buildFinalArgs('list.txt', 'out.mp4', caps(false), {
      preferNvenc: false,
      images: [img()]
    })
    const s = args.join(' ')
    expect(s).toContain('-i C:/m/logo/image.png') // image added as an input
    expect(s).toContain('-filter_complex')
    expect(s).toContain('[1:v]scale=200:100,format=rgba[oimg0]') // index 1 (no audio inputs)
    // center anchor → top-left = (540-100, 960-50) = (440, 910)
    expect(s).toContain("[0:v][oimg0]overlay=440:910:enable='between(t,1.000,4.000)'[vi0]")
    expect(s).toContain('-map [vi0]')
    expect(s).toContain('-map 0:a?') // keep the concat's own audio
  })

  it('applies opacity via colorchannelmixer only when < 1', () => {
    const faded = buildFinalArgs('l', 'o', caps(false), { preferNvenc: false, images: [img({ opacity: 0.5 })] }).join(' ')
    expect(faded).toContain('colorchannelmixer=aa=0.500')
    const solid = buildFinalArgs('l', 'o', caps(false), { preferNvenc: false, images: [img({ opacity: 1 })] }).join(' ')
    expect(solid).not.toContain('colorchannelmixer')
  })

  it('places image inputs after audio inputs and burns text on top of images', () => {
    const args = buildFinalArgs('list.txt', 'out.mp4', caps(false), {
      preferNvenc: false,
      assFile: 'overlays.ass',
      images: [img()],
      audio: { inputPaths: ['bed.m4a'], filter: '[1:a]anull[aout]', outLabel: 'aout' }
    })
    const s = args.join(' ')
    // audio input is index 1, so the image is index 2
    expect(s).toContain('[2:v]scale=200:100')
    // ass runs after the image overlay (text above images)
    expect(s).toContain('[vi0]ass=overlays.ass[v]')
    expect(s).toContain('-map [v]')
    expect(s).toContain('-map [aout]')
  })

  it('honors top-left anchor (no centering offset)', () => {
    const s = buildFinalArgs('l', 'o', caps(false), {
      preferNvenc: false,
      images: [img({ anchor: 'topLeft', x: 100, y: 200 })]
    }).join(' ')
    expect(s).toContain('overlay=100:200:')
  })
})
