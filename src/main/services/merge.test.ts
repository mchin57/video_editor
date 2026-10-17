import { describe, expect, it } from 'vitest'
import type { FfmpegEncoders } from '@shared/ffmpeg'
import type { AudioStreamInfo, ProbeInfo, VideoStreamInfo } from '@shared/media'
import { buildMergeArgs, mergeExt, type MergeInput } from './merge'
import { mergePlan } from '@shared/merge'

const ALL: FfmpegEncoders = { h264_nvenc: true, hevc_nvenc: true, libx264: true, libx265: true, aac: true }

const video = (v: Partial<VideoStreamInfo> = {}): VideoStreamInfo => ({
  codec: 'h264',
  width: 1920,
  height: 1080,
  displayWidth: 1080,
  displayHeight: 1920,
  rotationDeg: 90,
  avgFps: 29.97,
  rFps: 30,
  isVfr: false,
  pixFmt: 'yuv420p',
  colorTransfer: 'bt709',
  colorPrimaries: 'bt709',
  colorSpace: 'bt709',
  isHdr: false,
  ...v
})
const probe = (v: Partial<VideoStreamInfo> = {}, audio: Partial<AudioStreamInfo> | false = {}): ProbeInfo => ({
  durationSec: 10,
  container: 'mov,mp4',
  video: video(v),
  audio: audio === false ? null : { codec: 'aac', sampleRate: 48000, channels: 2, ...audio }
})
const input = (path: string, p: ProbeInfo, inSec: number, outSec: number): MergeInput => ({
  path,
  probe: p,
  segment: { mediaId: path, inSec, outSec }
})
const args = (inputs: MergeInput[]): string => buildMergeArgs(inputs, 'out.mp4', ALL).join(' ')

const NORM = (w: number, h: number, fps: number, fmt: string, len: string): string =>
  `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=${fmt},setpts=PTS-STARTPTS,trim=duration=${len}`
const AUD = (len: string): string =>
  `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,asetpts=PTS-STARTPTS,atrim=duration=${len}`

describe('buildMergeArgs', () => {
  it('SDR: one frame-exact input per segment, normalized, silence for a clip without audio, concat', () => {
    const a = args([
      input('a.mov', probe(), 0.5004, 2.5),
      input('b.mp4', probe({ displayWidth: 1080, displayHeight: 1920, avgFps: 60 }, false), 0, 2),
      input('a.mov', probe(), 1, 3)
    ])
    expect(a).toBe(
      '-y -hide_banner -nostdin -ss 0.500 -t 2.000 -i a.mov -ss 0.000 -t 2.000 -i b.mp4 -ss 1.000 -t 2.000 -i a.mov ' +
        '-filter_complex ' +
        `[0:v:0]${NORM(1080, 1920, 60, 'yuv420p', '2.000')}[v0];[0:a:0]${AUD('2.000')}[a0];` +
        `[1:v:0]${NORM(1080, 1920, 60, 'yuv420p', '2.000')}[v1];anullsrc=r=48000:cl=stereo,atrim=duration=2.000[a1];` +
        `[2:v:0]${NORM(1080, 1920, 60, 'yuv420p', '2.000')}[v2];[2:a:0]${AUD('2.000')}[a2];` +
        '[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a] ' +
        '-map [v] -map [a] -map_metadata 0 ' +
        '-c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq 18 -b:v 0 -pix_fmt yuv420p ' +
        '-color_primaries bt709 -color_trc bt709 -colorspace bt709 ' +
        '-c:a aac -b:a 256k -movflags +faststart -progress pipe:1 -nostats out.mp4'
    )
  })

  it('no audio anywhere: video-only concat and -an; a one-sided mic is folded', () => {
    const silent = args([input('a.mov', probe({}, false), 0, 1), input('b.mov', probe({}, false), 0, 1)])
    expect(silent).toContain('[v0][v1]concat=n=2:v=1:a=0[v] -map [v] -map_metadata 0')
    expect(silent).toContain(' -an ')
    expect(silent).not.toContain('anullsrc')
    const folded = args([input('a.mov', probe({}, { monoFoldChannel: 1 }), 0, 1), input('b.mov', probe(), 0, 1)])
    expect(folded).toContain('[0:a:0]pan=stereo|c0=c1|c1=c1,aresample=48000')
    expect(folded).toContain('[1:a:0]aresample=48000')
  })

  it('HDR + SDR: the HDR clip is tone-mapped and the merge is 8-bit bt709 H.264', () => {
    const hlg = {
      codec: 'hevc',
      pixFmt: 'yuv420p10le',
      isHdr: true,
      colorTransfer: 'arib-std-b67',
      colorPrimaries: 'bt2020',
      colorSpace: 'bt2020nc'
    }
    const a = args([input('h.mov', probe(hlg), 0, 1), input('s.mov', probe(), 0, 1)])
    expect(a).toContain('[0:v:0]zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:t=linear,')
    expect(a).toContain(`[1:v:0]${NORM(1080, 1920, 30, 'yuv420p', '1.000')}[v1]`)
    expect(a).toContain(
      '-c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq 18 -b:v 0 -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709'
    )
  })

  it("all HDR: kept 10-bit HEVC with the first clip's tags", () => {
    const hlg = {
      codec: 'hevc',
      pixFmt: 'yuv420p10le',
      isHdr: true,
      colorTransfer: 'arib-std-b67',
      colorPrimaries: 'bt2020',
      colorSpace: 'bt2020nc'
    }
    const a = args([input('h.mov', probe(hlg), 0, 1), input('h.mov', probe(hlg), 2, 3)])
    expect(a).not.toContain('zscale')
    expect(a).toContain(`[0:v:0]${NORM(1080, 1920, 30, 'yuv420p10le', '1.000')}[v0]`)
    expect(a).toContain(
      '-c:v hevc_nvenc -preset p6 -tune hq -rc vbr -cq 18 -b:v 0 -profile:v main10 -pix_fmt p010le -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -tag:v hvc1'
    )
  })

  it('any alpha clip: VP9 WebM with alpha, libvpx decoder before its -i, clear letterbox, Opus', () => {
    const alpha = probe({ codec: 'vp9', hasAlpha: true, displayWidth: 540, displayHeight: 960 })
    const inputs = [input('m.webm', alpha, 0, 2), input('b.mp4', probe(), 0, 1)]
    expect(mergeExt(mergePlan(inputs.map((i) => i.probe.video!)))).toBe('webm')
    const a = args(inputs)
    expect(a).toMatch(
      /^-y -hide_banner -nostdin -c:v libvpx-vp9 -ss 0.000 -t 2.000 -i m.webm -ss 0.000 -t 1.000 -i b.mp4 /
    )
    expect(a).toContain(
      '[1:v:0]format=yuva420p,scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=30,format=yuva420p,'
    )
    expect(a).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 20 -row-mt 1 -c:a libopus -b:a 192k -progress')
    expect(a).not.toContain('faststart')
  })

  it('refuses a source without a picture', () => {
    expect(() =>
      buildMergeArgs([input('a.wav', { ...probe(), video: null }, 0, 1), input('b.mov', probe(), 0, 1)], 'o.mp4', ALL)
    ).toThrow(/video/)
  })
})
