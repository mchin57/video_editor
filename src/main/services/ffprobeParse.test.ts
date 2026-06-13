import { describe, it, expect } from 'vitest'
import {
  parseFfprobeJson,
  parseRate,
  normalizeRotation,
  type FfprobeJson
} from './ffprobeParse'

describe('parseRate', () => {
  it('parses rationals', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseRate('30/1')).toBe(30)
  })
  it('handles unknown/zero', () => {
    expect(parseRate('0/0')).toBe(0)
    expect(parseRate(undefined)).toBe(0)
    expect(parseRate('N/A')).toBe(0)
  })
})

describe('normalizeRotation', () => {
  it('snaps to 0/90/180/270', () => {
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(-270)).toBe(90)
    expect(normalizeRotation(180)).toBe(180)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(0)).toBe(0)
  })
})

describe('parseFfprobeJson — iPhone HEVC HDR, stored landscape + 90° display matrix', () => {
  const json: FfprobeJson = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p10le',
        color_transfer: 'smpte2084',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
        avg_frame_rate: '30/1',
        r_frame_rate: '30/1',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
      },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 }
    ],
    format: { duration: '12.345000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
  }
  const p = parseFfprobeJson(json)

  it('swaps dimensions for portrait display', () => {
    expect(p.video?.width).toBe(1920)
    expect(p.video?.height).toBe(1080)
    expect(p.video?.displayWidth).toBe(1080)
    expect(p.video?.displayHeight).toBe(1920)
    expect(p.video?.rotationDeg).toBe(270)
  })
  it('flags HDR', () => {
    expect(p.video?.isHdr).toBe(true)
    expect(p.video?.colorTransfer).toBe('smpte2084')
  })
  it('reads duration + audio', () => {
    expect(p.durationSec).toBeCloseTo(12.345, 3)
    expect(p.audio?.codec).toBe('aac')
    expect(p.audio?.channels).toBe(2)
  })
})

describe('parseFfprobeJson — landscape H.264 SDR CFR', () => {
  const json: FfprobeJson = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p',
        color_transfer: 'bt709',
        avg_frame_rate: '30/1',
        r_frame_rate: '30/1'
      }
    ],
    format: { duration: '8.0', format_name: 'mov,mp4' }
  }
  const p = parseFfprobeJson(json)

  it('no rotation, no swap', () => {
    expect(p.video?.displayWidth).toBe(1920)
    expect(p.video?.displayHeight).toBe(1080)
    expect(p.video?.rotationDeg).toBe(0)
  })
  it('not HDR, not VFR', () => {
    expect(p.video?.isHdr).toBe(false)
    expect(p.video?.isVfr).toBe(false)
  })
  it('no audio stream → null', () => {
    expect(p.audio).toBeNull()
  })
})

describe('parseFfprobeJson — VFR detection + legacy rotate tag', () => {
  const json: FfprobeJson = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1080,
        height: 1920,
        pix_fmt: 'yuv420p',
        color_transfer: 'unknown', // ffprobe placeholder → null
        avg_frame_rate: '30000/1001', // 29.97
        r_frame_rate: '60/1', // big disagreement → VFR
        tags: { rotate: '180' }
      }
    ],
    format: { duration: '5.0', format_name: 'mov' }
  }
  const p = parseFfprobeJson(json)

  it('detects VFR from avg vs r disagreement', () => {
    expect(p.video?.isVfr).toBe(true)
  })
  it('reads legacy rotate tag (180 → no dimension swap)', () => {
    expect(p.video?.rotationDeg).toBe(180)
    expect(p.video?.displayWidth).toBe(1080)
    expect(p.video?.displayHeight).toBe(1920)
  })
  it('normalizes "unknown" transfer to null and not HDR', () => {
    expect(p.video?.colorTransfer).toBeNull()
    expect(p.video?.isHdr).toBe(false)
  })
})
