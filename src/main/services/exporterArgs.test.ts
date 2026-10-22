import { describe, it, expect } from 'vitest'
import {
  buildExportArgs,
  exportAudioClips,
  buildFrameArgs,
  frameIndexAt,
  buildVidstabDetectArgs,
  buildVidstabTransformArgs,
  escapeFilterPath,
  targetForPreset,
  withFilterGraphFile,
  FILTER_GRAPH_FILE,
  type ExportPlan,
  type ExportVideo,
  type StabilizeJob
} from './exporterArgs'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import type { AudioClip, VolumeLevel } from '@shared/project'
import type { LoudnessSeries } from '@shared/loudness'

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
    expect(targetForPreset('landscape')).toEqual({ width: 1920, height: 1080 })
    expect(targetForPreset('feed')).toEqual({ width: 1080, height: 1350 })
    expect(targetForPreset('cinematic')).toEqual({ width: 2520, height: 1080 })
  })
  it('falls back to the Reel size for an unknown preset id', () => {
    expect(targetForPreset('nope')).toEqual({ width: 1080, height: 1920 })
  })
  it('a landscape base canvas is 1920x1080', () => {
    const s = buildExportArgs(
      plan({ target: targetForPreset('landscape'), visuals: [{ kind: 'video', video: vid }] }),
      'out.mp4'
    ).join(' ')
    expect(s).toContain('-f lavfi -i color=c=black:s=1920x1080:r=30:d=10.000')
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
    expect(s).toContain("[0:v][pv1]overlay=0:0:enable='between(t,1.000,6.000)':eof_action=repeat[v0]")
    expect(s).toContain('-map [v0]')
  })

  it('applies hdr tonemap, crop, and color eq in order when present', () => {
    const s = buildExportArgs(
      plan({
        visuals: [
          {
            kind: 'video',
            video: {
              ...vid,
              hdrChain: 'tonemapX',
              crop: { x: 10, y: 20, w: 600, h: 1000 },
              colorEq: 'eq=brightness=0.1'
            }
          }
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

    const alpha = buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, hasAlpha: true } }] }), 'o').join(
      ' '
    )
    expect(alpha).toContain('setsar=1,format=yuva420p,setpts=')
    expect(alpha).not.toContain('format=yuv420p,setpts=')
  })

  it('forces the input decoder for a VP9-alpha clip (native decode drops the alpha)', () => {
    const s = buildExportArgs(
      plan({ visuals: [{ kind: 'video', video: { ...vid, hasAlpha: true, inputDecoder: 'libvpx-vp9' } }] }),
      'o'
    ).join(' ')
    expect(s).toContain('-c:v libvpx-vp9 -ss 2.000 -t 5.000 -i C:/v/a.mov')

    const plain = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o').join(' ')
    expect(plain).toContain('-ss 2.000 -t 5.000 -i C:/v/a.mov')
    expect(plain).not.toContain('-c:v libvpx-vp9 -ss')
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

  // REGRESSION: a freeze hold parked at the clip's END (atLocal === len — what
  // "freeze the last frame" produces) shifts NO frames forward, so the layer's
  // `-t`-limited input simply stops at len and the hold exists only as the
  // overlay repeating its last frame. With the old `eof_action=pass` the base
  // canvas showed through and the layer went BLACK for the whole hold.
  it('holds the last frame past EOF so a freeze at the clip end is not blacked out', () => {
    const s = buildExportArgs(
      plan({
        visuals: [
          {
            kind: 'video',
            video: {
              ...vid,
              endSec: 15,
              freezes: [
                { atLocal: 5, holdSec: 2 },
                { atLocal: 5, holdSec: 7 }
              ]
            }
          }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain('-ss 2.000 -t 5.000 -i C:/v/a.mov') // input still reads only the trim
    expect(s).toContain("enable='between(t,1.000,15.000)':eof_action=repeat[v0]")
    expect(s).not.toContain('eof_action=pass')
  })

  // REGRESSION (mirror of the above): a hold at the clip's START would otherwise
  // emit `gte(T-STARTT\,0.000)`, which catches frame 0 too — the whole stream
  // shifts and no earlier frame is left for framesync to repeat, so the layer
  // rendered BLACK for the hold. The threshold is nudged past frame 0 instead.
  it('nudges a freeze at the clip start past frame 0 so it holds instead of blacking out', () => {
    const s = buildExportArgs(
      plan({ visuals: [{ kind: 'video', video: { ...vid, endSec: 9, freezes: [{ atLocal: 0, holdSec: 3 }] } }] }),
      'o'
    ).join(' ')
    expect(s).toContain('setpts=PTS-STARTPTS+(gte(T-STARTT\\,0.001)*3.000)/TB+1.000/TB[pv1]')
    expect(s).not.toContain('gte(T-STARTT\\,0.000)')
  })

  it('nudges a start freeze in the ramped form too, leaving mid-clip thresholds exact', () => {
    const ramp = [
      { u: 0, v: 1 },
      { u: 5, v: 1 }
    ]
    const s = buildExportArgs(
      plan({
        visuals: [{ kind: 'video', video: { ...vid, ramp, endSec: 9, freezes: [{ atLocal: 0, holdSec: 3 }] } }]
      }),
      'o'
    ).join(' ')
    expect(s).toContain('gte(T-STARTT,0.001)*3.000')
    expect(s).not.toContain('gte(T-STARTT,0.000)')

    // 1 ms is below f3's rounding, so an ordinary mid-clip hold is unchanged.
    const mid = buildExportArgs(
      plan({ visuals: [{ kind: 'video', video: { ...vid, ramp, freezes: [{ atLocal: 1.5, holdSec: 2 }] } }] }),
      'o'
    ).join(' ')
    expect(mid).toContain('gte(T-STARTT,1.500)*2.000')
  })

  it('scales PTS for clip speed (slow-mo doubles the spacing) and composes with freezes', () => {
    const slow = buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, speed: 0.5 } }] }), 'o').join(' ')
    expect(slow).toContain('setpts=(PTS-STARTPTS)/0.500+1.000/TB[pv1]')

    const fastFrozen = buildExportArgs(
      plan({ visuals: [{ kind: 'video', video: { ...vid, speed: 2, freezes: [{ atLocal: 1.5, holdSec: 2 }] } }] }),
      'o'
    ).join(' ')
    // Freeze threshold stays in SOURCE time; the hold stays wall-clock.
    expect(fastFrozen).toContain('setpts=(PTS-STARTPTS)/2.000+(gte(T-STARTT\\,1.500)*2.000)/TB+1.000/TB[pv1]')

    const normal = buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, speed: 1 } }] }), 'o').join(' ')
    expect(normal).toContain('setpts=PTS-STARTPTS+1.000/TB[pv1]') // speed 1 emits the plain form
  })

  it('bakes a speed RAMP into a quoted piecewise log-integral setpts', () => {
    // speed 1 → 2 over the 5s trim; ramp overrides the constant speed field.
    const ramp = [
      { u: 0, v: 1 },
      { u: 5, v: 2 }
    ]
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, speed: 0.5, ramp } }] }), 'o').join(
      ' '
    )
    // m = 0.2; total = ln(2)/0.2 = 3.465736, held past the trim end. The whole
    // value is single-quoted (commas unescaped) — verified against ffmpeg 8.1.1,
    // see FFMPEG-NOTES "Speed ramps".
    expect(s).toContain(
      "setpts='(if(lt(T-STARTT,5.000000),0.000000+log((1.000000+0.200000*(T-STARTT-0.000000))/1.000000)/0.200000,3.465736)+1.000)/TB'[pv1]"
    )

    // Freeze thresholds stay in source time (unescaped inside the quotes).
    const frozen = buildExportArgs(
      plan({
        visuals: [{ kind: 'video', video: { ...vid, ramp, freezes: [{ atLocal: 1.5, holdSec: 2 }] } }]
      }),
      'o'
    ).join(' ')
    expect(frozen).toContain(
      "setpts='(if(lt(T-STARTT,5.000000),0.000000+log((1.000000+0.200000*(T-STARTT-0.000000))/1.000000)/0.200000,3.465736)+gte(T-STARTT,1.500)*2.000+1.000)/TB'[pv1]"
    )
  })

  it('keyframed opacity inserts format=rgba + sendcmd + colorchannelmixer after setpts', () => {
    const s = buildExportArgs(
      plan({
        visuals: [
          {
            kind: 'video',
            video: { ...vid, opacity: { cmdFile: 'opacity_0.cmd', id: 'op0', initial: 1 } }
          }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain(
      'setpts=PTS-STARTPTS+1.000/TB,format=rgba,sendcmd=f=opacity_0.cmd,colorchannelmixer@op0=aa=1.000[pv1]'
    )

    // A constant non-1 opacity has no command file — just the initial aa.
    const constant = buildExportArgs(
      plan({
        visuals: [{ kind: 'video', video: { ...vid, opacity: { cmdFile: null, id: 'op0', initial: 0.5 } } }]
      }),
      'o'
    ).join(' ')
    expect(constant).toContain(',format=rgba,colorchannelmixer@op0=aa=0.500[pv1]')
    expect(constant).not.toContain('sendcmd')
  })

  it('an opacity-animated image becomes a -loop 1 + fps=30 stream with sendcmd', () => {
    const im = {
      path: 'C:/v/i.png',
      boxW: 200,
      boxH: 100,
      x: 10,
      y: 20,
      startSec: 1,
      endSec: 4,
      opacity: 1,
      opacityAnim: { cmdFile: 'opacity_1.cmd', id: 'op1', initial: 0.8 }
    }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'image', image: im }] }), 'o').join(' ')
    expect(s).toContain('-loop 1 -t 4.000 -i C:/v/i.png')
    expect(s).toContain(
      '[1:v]scale=200:100,format=rgba,fps=30,sendcmd=f=opacity_1.cmd,colorchannelmixer@op1=aa=0.800[pi1]'
    )
  })

  it('moves the filtergraph out of the command line into graph.txt', () => {
    const args = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o')
    const { args: run, graph } = withFilterGraphFile(args)
    expect(graph).toBe(args[args.indexOf('-filter_complex') + 1])
    expect(run).not.toContain('-filter_complex')
    expect(run.slice(run.indexOf('-/filter_complex'), run.indexOf('-/filter_complex') + 2)).toEqual([
      '-/filter_complex',
      FILTER_GRAPH_FILE
    ])
    expect(run).toHaveLength(args.length)
    expect(withFilterGraphFile(['-i', 'x'])).toEqual({ args: ['-i', 'x'], graph: null })
  })

  it('a draw-on mark reads its PNG sequence at 30 fps, holds the last frame and starts at its time', () => {
    const im = {
      path: 'C:/t/graphics_0_%03d.png',
      boxW: 200,
      boxH: 100,
      x: 10,
      y: 20,
      startSec: 1,
      endSec: 4,
      opacity: 1,
      sequence: { frames: 13 }
    }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'image', image: im }] }), 'o').join(' ')
    expect(s).toContain('-framerate 30 -i C:/t/graphics_0_%03d.png')
    expect(s).not.toContain('-loop 1')
    // 3s window − 13/30s of drawing = 2.567s held.
    expect(s).toContain(
      '[1:v]tpad=stop_mode=clone:stop_duration=2.567,setpts=PTS-STARTPTS+1.000/TB,scale=200:100,format=rgba[pi1]'
    )
    expect(s).toContain("overlay=10:20:enable='between(t,1.000,4.000)'")
  })

  it('a fading mark becomes a -loop 1 + fps=30 stream with an alpha fade from its start', () => {
    const im = {
      path: 'C:/t/graphics_1_000.png',
      boxW: 200,
      boxH: 100,
      x: 10,
      y: 20,
      startSec: 1.5,
      endSec: 4,
      opacity: 1,
      fadeIn: { startSec: 1.5, durSec: 0.4 }
    }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'image', image: im }] }), 'o').join(' ')
    expect(s).toContain('-loop 1 -t 4.000 -i C:/t/graphics_1_000.png')
    expect(s).toContain('[1:v]scale=200:100,format=rgba,fps=30,fade=t=in:st=1.500:d=0.400:alpha=1[pi1]')
  })

  it('tempo-matches a re-timed layer audio with an atempo chain', () => {
    const s = buildExportArgs(
      plan({
        visuals: [{ kind: 'video', video: vid }],
        audio: [
          {
            path: 'C:/v/a.mov',
            inSec: 2,
            outSec: 7,
            startSec: 1,
            gainDb: 0,
            fadeInSec: 0,
            fadeOutSec: 0,
            duck: false,
            tempo: 4
          }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain('atempo=2.000,atempo=2.000,adelay=1000|1000')
  })

  it('keyframed video scales per-frame AFTER setpts and centers via overlay exprs', () => {
    const kfs = [
      { t: 1, w: 500, h: 900, cx: 540, cy: 960 },
      { t: 3, w: 700, h: 1260, cx: 300, cy: 500 }
    ]
    const s = buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, keyframes: kfs } }] }), 'o').join(' ')
    // No static one-shot scale; animated scale follows the setpts shift.
    expect(s).not.toContain('scale=1080:1920')
    expect(s).toContain(
      "setpts=PTS-STARTPTS+1.000/TB,scale=w='trunc((if(lt(t,1.000),500.000,if(lt(t,3.000),500.000+200.000*(t-1.000)/2.000,700.000)))/2)*2'"
    )
    expect(s).toContain(':eval=frame:flags=bicubic[pv1]')
    expect(s).toContain(
      "overlay=x='(if(lt(t,1.000),540.000,if(lt(t,3.000),540.000+-240.000*(t-1.000)/2.000,300.000)))-overlay_w/2'"
    )
    expect(s).toContain("-overlay_h/2':enable='between(t,1.000,6.000)':eof_action=repeat[v0]")
  })

  it('keyframed image becomes a -loop 1 frame stream with fps and per-frame scale', () => {
    const img = {
      path: 'C:/i/p.png',
      boxW: 300,
      boxH: 200,
      x: 100,
      y: 100,
      startSec: 0,
      endSec: 4,
      opacity: 1,
      keyframes: [
        { t: 0, w: 300, h: 200, cx: 250, cy: 200 },
        { t: 4, w: 600, h: 400, cx: 540, cy: 960 }
      ]
    }
    const s = buildExportArgs(plan({ visuals: [{ kind: 'image', image: img }] }), 'o').join(' ')
    expect(s).toContain('-loop 1 -t 4.000 -i C:/i/p.png')
    expect(s).toContain(
      "format=rgba,fps=30,scale=w='trunc((if(lt(t,0.000),300.000,if(lt(t,4.000),300.000+300.000*(t-0.000)/4.000,600.000)))/2)*2'"
    )
    expect(s).toContain("overlay=x='(if(lt(t,0.000),250.000,")

    // Static images keep the exact original input/chain form.
    const staticImg = { ...img, keyframes: [] }
    const s2 = buildExportArgs(plan({ visuals: [{ kind: 'image', image: staticImg }] }), 'o').join(' ')
    expect(s2).toContain('-i C:/i/p.png')
    expect(s2).not.toContain('-loop 1')
    expect(s2).toContain('scale=300:200,format=rgba')
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
    const s = buildExportArgs(
      plan({
        visuals: [
          { kind: 'video', video: vid },
          { kind: 'image', image: img }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain(
      '[2:v]crop=iw*0.500:ih*0.500:iw*0.100:ih*0.200,transpose=1,hflip,scale=300:200,format=rgba[pi2]'
    )
  })

  describe('layer rotation (free angle) + video flips', () => {
    const ROT30 = "rotate=a=0.523599:ow='ceil(rotw(0.523599)/2)*2':oh='ceil(roth(0.523599)/2)*2':c=none"

    it('rotates a static video AFTER its box scale, in an alpha pipeline, centred on the box', () => {
      const s = buildExportArgs(
        plan({
          visuals: [{ kind: 'video', video: { ...vid, boxW: 400, boxH: 200, x: 340, y: 860, rotationDeg: 30 } }]
        }),
        'o'
      ).join(' ')
      expect(s).toContain(
        `[1:v]scale=400:200:flags=bicubic,setsar=1,format=yuva420p,setpts=PTS-STARTPTS+1.000/TB,${ROT30}[pv1]`
      )
      // The rotated output is the rotated bounds, so it is placed by its centre.
      expect(s).toContain("overlay=x='540.000-overlay_w/2':y='960.000-overlay_h/2':enable='between(t,1.000,6.000)'")
    })

    it('flips the cropped picture before scaling', () => {
      const s = buildExportArgs(
        plan({
          visuals: [
            { kind: 'video', video: { ...vid, crop: { x: 0, y: 0, w: 600, h: 1000 }, flipH: true, flipV: true } }
          ]
        }),
        'o'
      ).join(' ')
      expect(s).toContain('[1:v]crop=600:1000:0:0,hflip,vflip,scale=1080:1920:flags=bicubic,')
    })

    it('rotates a keyframed video once at its largest box, then scales the ROTATED bounds per frame', () => {
      const kfs = [
        { t: 1, w: 400, h: 200, cx: 540, cy: 960 },
        { t: 3, w: 800, h: 400, cx: 300, cy: 500 }
      ]
      const s = buildExportArgs(
        plan({ visuals: [{ kind: 'video', video: { ...vid, keyframes: kfs, rotationDeg: 90 } }] }),
        'o'
      ).join(' ')
      expect(s).toContain(
        '[1:v]scale=800:400:flags=bicubic,setsar=1,format=yuva420p,setpts=PTS-STARTPTS+1.000/TB,rotate=a=1.570796:'
      )
      // 90°: bounds swap, so the per-frame width follows the boxes' HEIGHTS (200 → 400).
      expect(s).toContain(
        "c=none,scale=w='trunc((if(lt(t,1.000),200.000,if(lt(t,3.000),200.000+200.000*(t-1.000)/2.000,400.000)))/2)*2'"
      )
      expect(s).toContain("overlay=x='(if(lt(t,1.000),540.000,")
    })

    it('rotates a static image after its box scale, centred', () => {
      const img = {
        path: 'C:/i/p.png',
        boxW: 300,
        boxH: 200,
        x: 100,
        y: 100,
        startSec: 0,
        endSec: 3,
        opacity: 1,
        rotationDeg: 30
      }
      const s = buildExportArgs(plan({ visuals: [{ kind: 'image', image: img }] }), 'o').join(' ')
      expect(s).toContain(`[1:v]scale=300:200,format=rgba,${ROT30}[pi1]`)
      expect(s).toContain("overlay=x='250.000-overlay_w/2':y='200.000-overlay_h/2'")
    })

    it('rotates a keyframed image on its frame stream before the per-frame scale', () => {
      const img = {
        path: 'C:/i/p.png',
        boxW: 300,
        boxH: 200,
        x: 100,
        y: 100,
        startSec: 0,
        endSec: 4,
        opacity: 1,
        rotationDeg: 30,
        keyframes: [
          { t: 0, w: 300, h: 200, cx: 250, cy: 200 },
          { t: 4, w: 600, h: 400, cx: 540, cy: 960 }
        ]
      }
      const s = buildExportArgs(plan({ visuals: [{ kind: 'image', image: img }] }), 'o').join(' ')
      expect(s).toContain(`[1:v]scale=600:400,format=rgba,fps=30,${ROT30},scale=w='trunc((`)
    })

    it('treats 0° and 360° as no rotation (strings unchanged)', () => {
      const base = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o').join(' ')
      for (const rotationDeg of [0, 360]) {
        expect(
          buildExportArgs(plan({ visuals: [{ kind: 'video', video: { ...vid, rotationDeg } }] }), 'o').join(' ')
        ).toBe(base)
      }
    })
  })

  it('composites an image after the videos: scale, rgba, opacity, gated overlay', () => {
    const img = { path: 'C:/i/logo.png', boxW: 300, boxH: 200, x: 100, y: 50, startSec: 0, endSec: 3, opacity: 0.5 }
    const s = buildExportArgs(
      plan({
        visuals: [
          { kind: 'video', video: vid },
          { kind: 'image', image: img }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain('[2:v]scale=300:200,format=rgba,colorchannelmixer=aa=0.500[pi2]') // input 2 (after video 1)
    expect(s).toContain("overlay=100:50:enable='between(t,0.000,3.000)'")
  })

  it('omits colorchannelmixer at full opacity', () => {
    const img = { path: 'p.png', boxW: 1, boxH: 1, x: 0, y: 0, startSec: 0, endSec: 1, opacity: 1 }
    const s = buildExportArgs(
      plan({
        visuals: [
          { kind: 'video', video: vid },
          { kind: 'image', image: img }
        ]
      }),
      'o'
    ).join(' ')
    expect(s).toContain('format=rgba[pi2]')
    expect(s).not.toContain('colorchannelmixer')
  })

  it('burns text in z-order (below a later video) and captions on top', () => {
    const s = buildExportArgs(
      plan({
        visuals: [
          { kind: 'text', assFile: 'text_0.ass' },
          { kind: 'video', video: vid }
        ],
        captionsAss: 'captions.ass'
      }),
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
        audio: [
          { path: 'm.m4a', inSec: 0, outSec: 8, startSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false }
        ]
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

  describe('audio clips through volume levels (exportAudioClips → clipGain)', () => {
    /** A steady source: every 0.1 s step at `m` LUFS momentary, `p` dBFS peak. */
    const steady = (m: number, p: number): LoudnessSeries => ({
      version: 1,
      stepSec: 0.1,
      startSec: 0,
      momentary: Array.from({ length: 100 }, (_, i) => (i < 3 ? null : m)),
      peak: Array.from({ length: 100 }, () => p)
    })
    const levels: VolumeLevel[] = [{ id: 'default', name: 'Default', targetLufs: -16 }]
    const clipA = (over: Partial<AudioClip> = {}): AudioClip => ({
      id: 'a1',
      mediaId: 'm1',
      startSec: 0,
      inSec: 0,
      outSec: 8,
      gainDb: -6,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'extracted',
      ...over
    })
    const audioChain = (c: AudioClip, series: LoudnessSeries | null): string => {
      const audio = exportAudioClips(
        [c],
        () => ({ path: 'C:/v/voice.mov', durationSec: 10, foldChannel: null }),
        { levels, seriesOf: () => series },
        false
      )
      const args = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }], audio }), 'o').join(' ')
      return /\[2:a\][^;]*\[ac0\]/.exec(args)?.[0] ?? ''
    }

    it('a clip in no level exports at its own gain — the same string as before levels', () => {
      expect(audioChain(clipA(), steady(-30, -20))).toBe(
        '[2:a]atrim=0.000:8.000,asetpts=N/SR/TB,adelay=0|0,asetpts=N/SR/TB,volume=0.501[ac0]'
      )
    })

    it('a clip in a level is matched to the target (−30 → −16 LUFS: +14 dB), its own gain unused', () => {
      expect(audioChain(clipA({ volumeLevelId: 'default' }), steady(-30, -20))).toBe(
        '[2:a]atrim=0.000:8.000,asetpts=N/SR/TB,adelay=0|0,asetpts=N/SR/TB,volume=5.012[ac0]'
      )
    })

    it('a boost the peak cannot take is capped at −1 dBFS (−36 LUFS, −12 dBFS peak: +11 dB)', () => {
      expect(audioChain(clipA({ volumeLevelId: 'default' }), steady(-36, -12))).toBe(
        '[2:a]atrim=0.000:8.000,asetpts=N/SR/TB,adelay=0|0,asetpts=N/SR/TB,volume=3.548[ac0]'
      )
    })

    it('a clip below the −45 LUFS floor is left as it is (0 dB)', () => {
      expect(audioChain(clipA({ volumeLevelId: 'default' }), steady(-50, -40))).toBe(
        '[2:a]atrim=0.000:8.000,asetpts=N/SR/TB,adelay=0|0,asetpts=N/SR/TB,volume=1.000[ac0]'
      )
    })

    it('a muted clip, or one whose media is unknown, never becomes an input', () => {
      const src = () => ({ path: 'x', durationSec: 10, foldChannel: null })
      expect(exportAudioClips([clipA({ mute: true })], src, { levels, seriesOf: () => null }, false)).toEqual([])
      expect(exportAudioClips([clipA()], () => null, { levels, seriesOf: () => null }, false)).toEqual([])
    })
  })

  it('uses NVENC when available + preferred, else libx264', () => {
    expect(
      buildExportArgs(
        plan({ visuals: [{ kind: 'video', video: vid }], caps: caps(true), preferNvenc: true }),
        'o'
      ).join(' ')
    ).toContain('h264_nvenc')
    expect(
      buildExportArgs(
        plan({ visuals: [{ kind: 'video', video: vid }], caps: caps(true), preferNvenc: false }),
        'o'
      ).join(' ')
    ).toContain('libx264')
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

describe('nested-composition intermediates (alpha)', () => {
  const alphaPlan = (over: Partial<ExportPlan> = {}): ExportPlan =>
    plan({ alpha: true, visuals: [{ kind: 'video', video: vid }], ...over })

  it('renders onto a TRANSPARENT base so the parent shows through', () => {
    const s = buildExportArgs(alphaPlan(), 'o.webm').join(' ')
    expect(s).toContain('-i color=c=black@0.0:s=1080x1920:r=30:d=10.000,format=yuva420p')
    // The opaque project export keeps its black canvas.
    const opaque = buildExportArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), 'o.mp4').join(' ')
    expect(opaque).toContain('-i color=c=black:s=1080x1920:r=30:d=10.000')
    expect(opaque).not.toContain('black@0.0')
  })

  it('encodes VP9 yuva420p — never NVENC/H.264, which have no alpha', () => {
    const s = buildExportArgs(alphaPlan({ caps: caps(true), preferNvenc: true }), 'o.webm').join(' ')
    expect(s).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p')
    expect(s).not.toContain('h264_nvenc')
    expect(s).not.toContain('libx264')
    // The encoder sets the pixel format; no second opaque -pix_fmt is appended.
    expect(s).not.toContain('-pix_fmt yuv420p')
  })

  it('drops mp4-only options and uses opus for a WebM intermediate', () => {
    const audio = [
      { path: 'a.m4a', inSec: 0, outSec: 3, startSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false }
    ]
    const s = buildExportArgs(alphaPlan({ audio }), 'o.webm').join(' ')
    expect(s).toContain('-c:a libopus')
    expect(s).not.toContain('-c:a aac')
    expect(s).not.toContain('+faststart') // no moov atom in WebM
  })
})

describe('stills mode (render_frame)', () => {
  const music = [
    { path: 'm.m4a', inSec: 0, outSec: 8, startSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false }
  ]

  it('frameIndexAt: the frame on screen at t is floor(t*30), clamped to the last frame', () => {
    expect(frameIndexAt(5, 60)).toBe(150)
    expect(frameIndexAt(10.25, 60)).toBe(307) // output -ss would round this to 308
    expect(frameIndexAt(1 / 30, 60)).toBe(1) // float noise must not drop a frame
    expect(frameIndexAt(-1, 60)).toBe(0)
    expect(frameIndexAt(99, 10)).toBe(299)
    expect(frameIndexAt(99, 10.01)).toBe(300) // the base canvas emits ceil(d*30) frames
  })

  it('keeps every input and chain, cuts one frame by index, and writes a JPEG without audio', () => {
    const p = plan({ visuals: [{ kind: 'video', video: vid }], audio: music, captionsAss: 'captions.ass' })
    const video = buildExportArgs(p, 'out.mp4')
    const still = buildFrameArgs(p, [{ index: 150, path: 'f0.jpg' }])
    const fc = (a: string[]): string => a[a.indexOf('-filter_complex') + 1]
    // Same composite as the export, minus the audio graph, plus the trim.
    const videoChains = fc(video)
      .split(';')
      .filter((c) => !c.includes('[1:a]') && !c.includes('aout') && !c.includes(':a]'))
    expect(fc(still)).toBe(
      [...videoChains, '[v1]trim=start_frame=150:end_frame=151,scale=720:1280:flags=bicubic[vf0]'].join(';')
    )
    expect(still).not.toContain('m.m4a')
    expect(still.join(' ')).toMatch(
      /-progress pipe:1 -nostats -map \[vf0\] -frames:v 1 -r 30 -fps_mode cfr -pix_fmt yuv420p -an -q:v 2 f0\.jpg$/
    )
  })

  it('several frames come out of one pass through a split', () => {
    const still = buildFrameArgs(plan({ visuals: [{ kind: 'video', video: vid }] }), [
      { index: 30, path: 'a.jpg' },
      { index: 90, path: 'b.jpg' }
    ])
    const fc = still[still.indexOf('-filter_complex') + 1]
    expect(
      fc.endsWith(
        '[v0]split=2[s0][s1];[s0]trim=start_frame=30:end_frame=31,scale=720:1280:flags=bicubic[vf0];[s1]trim=start_frame=90:end_frame=91,scale=720:1280:flags=bicubic[vf1]'
      )
    ).toBe(true)
    expect(still.filter((a) => a.endsWith('.jpg'))).toEqual(['a.jpg', 'b.jpg'])
    expect(still.filter((a) => a === '-map')).toHaveLength(2)
  })

  it('scales stills to fit 1280 on the long side, whatever the format', () => {
    const fc = (t: ReturnType<typeof targetForPreset>): string => {
      const a = buildFrameArgs(plan({ target: t, visuals: [{ kind: 'video', video: vid }] }), [
        { index: 0, path: 'f.jpg' }
      ])
      return a[a.indexOf('-filter_complex') + 1]
    }
    expect(fc(targetForPreset('landscape'))).toContain(',scale=1280:720:flags=bicubic[vf0]')
    expect(fc(targetForPreset('cinematic'))).toContain(',scale=1280:548:flags=bicubic[vf0]') // 2520x1080
    expect(fc({ width: 720, height: 720 })).toMatch(/trim=start_frame=0:end_frame=1\[vf0\]$/) // already small: no scale
  })

  it('leaves the ordinary export untouched', () => {
    const p = plan({ visuals: [{ kind: 'video', video: vid }], audio: music })
    expect(buildExportArgs(p, 'out.mp4').join(' ')).not.toMatch(/trim=start_frame|-q:v/)
  })
})
