import { describe, it, expect } from 'vitest'
import {
  buildExportArgs,
  buildVidstabDetectArgs,
  buildVidstabTransformArgs,
  escapeFilterPath,
  targetForPreset,
  type ExportPlan,
  type ExportVideo,
  type StabilizeJob
} from './exporterArgs'
import type { FfmpegCapabilities } from '@shared/ffmpeg'

const caps = (nvenc: boolean): FfmpegCapabilities =>
  ({ encoders: { h264_nvenc: nvenc } }) as unknown as FfmpegCapabilities
const target = targetForPreset('reel') // 1080x1920

const vid: ExportVideo = {
  path: 'C:/v/a.mov',
  inSec: 2,
  len: 5,
  hdrChain: '',
  crop: null,
  colorEq: '',
  boxW: 1080,
  boxH: 1920,
  x: 0,
  y: 0,
  startSec: 1,
  endSec: 6,
  freezes: []
}

function plan(over: Partial<ExportPlan> = {}): ExportPlan {
  return { target, totalDur: 10, visuals: [], audio: [], caps: caps(false), preferNvenc: false, ...over }
}

describe('targetForPreset', () => {
  it('maps presets to output sizes', () => {
    expect(targetForPreset('reel')).toEqual({ width: 1080, height: 1920 })
    expect(targetForPreset('square')).toEqual({ width: 1080, height: 1080 })
  })
})

describe('buildExportArgs', () => {
  it('starts from a black base canvas the length of the project', () => {
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'out.mp4').join(' ')
    expect(s).toContain('-f lavfi -i color=c=black:s=1080x1920:r=30:d=10.000')
  })

  it('composites a video: seeked input, scaled box, shifted pts, time-gated overlay', () => {
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'out.mp4').join(' ')
    expect(s).toContain('-ss 2.000 -t 5.000 -i C:/v/a.mov') // input 1
    expect(s).toContain('[1:v]scale=1080:1920:flags=bicubic,setsar=1,format=yuv420p,setpts=PTS-STARTPTS+1.000/TB[pv1]')
    expect(s).toContain("[0:v][pv1]overlay=0:0:enable='between(t,1.000,6.000)':eof_action=pass[v0]")
    expect(s).toContain('-map [v0]')
  })

  it('applies hdr tonemap, crop, and color eq in order when present', () => {
    const s = buildExportArgs(
      plan({
        visuals: [
          { kind: 'video', video: { ...vid, hdrChain: 'tonemapX', crop: { x: 10, y: 20, w: 600, h: 1000 }, colorEq: 'eq=brightness=0.1' } }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain(
      '[1:v]tonemapX,crop=600:1000:10:20,scale=1080:1920:flags=bicubic,eq=brightness=0.1,setsar=1,format=yuv420p,setpts=PTS-STARTPTS+1.000/TB[pv1]'
    )
  })

  it('keeps the alpha channel (format=yuva420p) for a background-removed clip so the overlay blends', () => {
    const opaque = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o').join(' ')
    expect(opaque).toContain('setsar=1,format=yuv420p,setpts=') // default path unchanged

    const alpha = buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, hasAlpha: true } }] }), 'o').join(' ')
    expect(alpha).toContain('setsar=1,format=yuva420p,setpts=')
    expect(alpha).not.toContain('format=yuv420p,setpts=')
  })

  it('stretches PTS for freeze holds (escaped commas), keeping the plain form with none', () => {
    const none = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o').join(' ')
    expect(none).toContain('setpts=PTS-STARTPTS+1.000/TB[pv1]') // unchanged when no freezes

    const frozen = buildExportArgs(
      plan({ visuals: [{ kind: 'video', video: { ...vid, freezes: [{ atLocal: 1.5, holdSec: 2 }] } }] }),
      'o'
    ).join(' ')
    expect(frozen).toContain('setpts=PTS-STARTPTS+(gte(T-STARTT\\,1.500)*2.000)/TB+1.000/TB[pv1]')
  })

  it('applies image crop, 90° rotation and flips before scaling', () => {
    const img = {
      path: 'C:/i/p.png',
      boxW: 300,
      boxH: 200,
      x: 0,
      y: 0,
      startSec: 0,
      endSec: 3,
      opacity: 1,
      crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
      rotateQuarters: 1,
      flipH: true,
      flipV: false
    }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }, { kind: 'image', image: img }] }), 'o').join(' ')
    expect(s).toContain('[2:v]crop=iw*0.500:ih*0.500:iw*0.100:ih*0.200,transpose=1,hflip,scale=300:200,format=rgba[pi2]')
  })

  it('composites an image after the videos: scale, rgba, opacity, gated overlay', () => {
    const img = { path: 'C:/i/logo.png', boxW: 300, boxH: 200, x: 100, y: 50, startSec: 0, endSec: 3, opacity: 0.5 }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }, { kind: 'image', image: img }] }), 'o').join(' ')
    expect(s).toContain('[2:v]scale=300:200,format=rgba,colorchannelmixer=aa=0.500[pi2]') // input 2 (after video 1)
    expect(s).toContain("overlay=100:50:enable='between(t,0.000,3.000)'")
  })

  it('omits colorchannelmixer at full opacity', () => {
    const img = { path: 'p.png', boxW: 1, boxH: 1, x: 0, y: 0, startSec: 0, endSec: 1, opacity: 1 }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }, { kind: 'image', image: img }] }), 'o').join(' ')
    expect(s).toContain('format=rgba[pi2]')
    expect(s).not.toContain('colorchannelmixer')
  })

  it('burns text in z-order (below a later video) and captions on top', () => {
    const s = buildExportArgs(
      plan({ visuals: [{ kind: 'text', assFile: 'text_0.ass' }, { kind: 'video', video: vid }], captionsAss: 'captions.ass' }),
      'o'
    ).join(' ')
    expect(s).toContain('[0:v]ass=text_0.ass[v0]') // text first (bottom)
    expect(s).toContain('[v0][pv1]overlay=') // then video over it
    expect(s).toContain('ass=captions.ass') // captions burned last (top)
  })

  it('passes fontsdir (escaped) to every ass= filter when set', () => {
    const s = buildExportArgs(
      plan({
        visuals: [{ kind: 'text', assFile: 'text_0.ass' }],
        captionsAss: 'captions.ass',
        fontsDir: 'C:\\app\\resources\\fonts'
      }),
      'o'
    ).join(' ')
    expect(s).toContain("ass=text_0.ass:fontsdir='C\\:/app/resources/fonts'")
    expect(s).toContain("ass=captions.ass:fontsdir='C\\:/app/resources/fonts'")
  })

  it('composites top overlays (gradient captions) above the caption track', () => {
    const top = { path: 'g.png', boxW: 1080, boxH: 1920, x: 0, y: 0, startSec: 1, endSec: 2, opacity: 1 }
    const s = buildExportArgs(
      plan({ visuals: [{ kind: 'video', video: vid }], captionsAss: 'captions.ass', topOverlays: [top] }),
      'o'
    ).join(' ')
    const capIdx = s.indexOf('ass=captions.ass')
    const topIdx = s.indexOf("enable='between(t,1.000,2.000)'")
    expect(capIdx).toBeGreaterThan(-1)
    expect(topIdx).toBeGreaterThan(capIdx) // gradient caption overlaid after captions
  })

  it('escapeFilterPath escapes backslashes and the drive colon', () => {
    expect(escapeFilterPath('C:\\a\\b')).toBe('C\\:/a/b')
    expect(escapeFilterPath('/usr/share/fonts')).toBe('/usr/share/fonts')
  })

  it('mixes audio and maps it; a video-only export maps no audio', () => {
    const withAudio = buildExportArgs(
      plan({
        visuals: [{ kind: 'video', video: vid }],
        audio: [{ path: 'm.m4a', inSec: 0, outSec: 8, startSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false }]
      }),
      'o'
    ).join(' ')
    expect(withAudio).toContain('-i m.m4a')
    expect(withAudio).toContain('[2:a]atrim=0.000:8.000') // audio input is index 2 (after the base + 1 video)
    expect(withAudio).toContain('-map [aout]')
    expect(withAudio).toContain('-c:a aac')

    const noAudio = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o').join(' ')
    expect(noAudio).not.toContain('-map [aout]')
    expect(noAudio).not.toContain('-c:a aac')
  })

  it('uses NVENC when available + preferred, else libx264', () => {
    expect(buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }], caps: caps(true), preferNvenc: true }), 'o').join(' ')).toContain('h264_nvenc')
    expect(buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }], caps: caps(true), preferNvenc: false }), 'o').join(' ')).toContain('libx264')
  })
})

const stab = (over: Partial<StabilizeJob> = {}): StabilizeJob => ({
  input: 'C:/v/a.mov',
  inSec: 2,
  len: 5,
  shakiness: 5,
  smoothing: 15,
  hdrChain: '',
  trfFile: 'stab_0.trf',
  outFile: 'stab_0.mp4',
  ...over
})

describe('buildVidstabDetectArgs', () => {
  it('analyses the trimmed segment and writes the transforms file (no real output)', () => {
    const s = buildVidstabDetectArgs(stab()).join(' ')
    expect(s).toContain('-ss 2.000 -t 5.000 -i C:/v/a.mov')
    expect(s).toContain('-vf vidstabdetect=shakiness=5:accuracy=15:result=stab_0.trf')
    expect(s).toContain('-f null -')
  })

  it('clamps shakiness into 1..10', () => {
    expect(buildVidstabDetectArgs(stab({ shakiness: 99 })).join(' ')).toContain('shakiness=10')
    expect(buildVidstabDetectArgs(stab({ shakiness: 0 })).join(' ')).toContain('shakiness=1')
  })
})

describe('buildVidstabTransformArgs', () => {
  it('applies the transforms file with auto-zoom + sharpen into a video-only intermediate', () => {
    const s = buildVidstabTransformArgs(stab()).join(' ')
    expect(s).toContain('-ss 2.000 -t 5.000 -i C:/v/a.mov')
    expect(s).toContain(
      '-vf vidstabtransform=input=stab_0.trf:smoothing=15:optzoom=1:zoom=0:interpol=bicubic,unsharp=5:5:0.8:3:3:0.4,format=yuv420p'
    )
    expect(s).toContain('-c:v libx264 -preset medium -crf 18 -an stab_0.mp4')
  })

  it('folds the HDR tonemap in front of the stabilize chain when present', () => {
    const s = buildVidstabTransformArgs(stab({ hdrChain: 'tonemapX' })).join(' ')
    expect(s).toContain('-vf tonemapX,vidstabtransform=input=stab_0.trf')
  })
})
