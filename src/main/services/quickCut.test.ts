import { describe, expect, it } from 'vitest'
import type { FfmpegEncoders } from '@shared/ffmpeg'
import type { ProbeInfo, VideoStreamInfo } from '@shared/media'
import { buildCutArgs, cutExt } from './quickCut'

const ALL: FfmpegEncoders = { h264_nvenc: true, hevc_nvenc: true, libx264: true, libx265: true, aac: true }
const SOFT: FfmpegEncoders = { ...ALL, h264_nvenc: false, hevc_nvenc: false }

const video = (v: Partial<VideoStreamInfo> = {}): VideoStreamInfo => ({
  codec: 'h264',
  width: 1920,
  height: 1080,
  displayWidth: 1080,
  displayHeight: 1920,
  rotationDeg: 90,
  avgFps: 59.94,
  rFps: 60,
  isVfr: true,
  pixFmt: 'yuv420p',
  colorTransfer: 'bt709',
  colorPrimaries: 'bt709',
  colorSpace: 'bt709',
  isHdr: false,
  ...v
})
const probe = (v: Partial<VideoStreamInfo> = {}, audio = true): ProbeInfo => ({
  durationSec: 10,
  container: 'mov,mp4',
  video: video(v),
  audio: audio ? { codec: 'aac', sampleRate: 48000, channels: 2 } : null
})
const piece = { inSec: 1.2345, outSec: 4 }
const args = (p: ProbeInfo, enc = ALL): string => buildCutArgs('in.mov', 'out.mp4', p, piece, enc).join(' ')

describe('buildCutArgs', () => {
  it('H.264 SDR: input seek, frame-exact window, NVENC, AAC, faststart', () => {
    expect(args(probe())).toBe(
      '-y -hide_banner -nostdin -ss 1.234 -i in.mov -t 2.766 -map 0:v:0 -map_metadata 0 -fps_mode passthrough ' +
        '-c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq 18 -b:v 0 -pix_fmt yuv420p ' +
        '-color_primaries bt709 -color_trc bt709 -colorspace bt709 ' +
        '-map 0:a:0? -c:a aac -b:a 256k -movflags +faststart -progress pipe:1 -nostats out.mp4'
    )
  })

  it('falls back to libx264 without NVENC, and drops audio when there is none', () => {
    const a = args(probe({}, false), SOFT)
    expect(a).toContain('-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p')
    expect(a).toContain(' -an ')
    expect(a).not.toContain('0:a:0')
  })

  it('HEVC 10-bit HDR stays HEVC Main10 with its tags', () => {
    const hdr = { codec: 'hevc', pixFmt: 'yuv420p10le', colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020', colorSpace: 'bt2020nc', isHdr: true }
    expect(args(probe(hdr))).toContain(
      '-c:v hevc_nvenc -preset p6 -tune hq -rc vbr -cq 18 -b:v 0 -profile:v main10 -pix_fmt p010le ' +
        '-color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -tag:v hvc1'
    )
    expect(args(probe(hdr), SOFT)).toContain('-c:v libx265 -preset medium -crf 18 -pix_fmt yuv420p10le -x265-params log-level=error')
    expect(args(probe(hdr), { ...SOFT, libx265: false })).toContain('-c:v libx264 -preset medium -crf 18 -profile:v high10 -pix_fmt yuv420p10le')
  })

  it('leaves out color tags ffmpeg would reject', () => {
    const a = args(probe({ colorTransfer: 'unknown', colorPrimaries: null, colorSpace: 'bt709' }))
    expect(a).not.toContain('-color_trc')
    expect(a).not.toContain('-color_primaries')
    expect(a).toContain('-colorspace bt709')
  })

  it('alpha WebM: libvpx decoder before -i, VP9 yuva420p, Opus, no faststart', () => {
    const p = probe({ codec: 'vp9', hasAlpha: true })
    expect(cutExt(p)).toBe('webm')
    expect(cutExt(probe())).toBe('mp4')
    const a = buildCutArgs('in.webm', 'out.webm', p, piece, ALL).join(' ')
    expect(a).toMatch(/^-y -hide_banner -nostdin -c:v libvpx-vp9 -ss 1.234 -i in.webm /)
    expect(a).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 20 -row-mt 1 -map 0:a:0? -c:a libopus -b:a 192k')
    expect(a).not.toContain('faststart')
  })

  it('refuses a source without a picture', () => {
    expect(() => buildCutArgs('a.wav', 'o.mp4', { ...probe(), video: null }, piece, ALL)).toThrow(/video/)
  })
})
