import { describe, it, expect } from 'vitest'
import type { ProbeInfo } from '@shared/media'
import {
  needsReprobe,
  parseFfprobeJson,
  parseRate,
  normalizeRotation,
  PROBE_VERSION,
  recordedUtcFromTags,
  type FfprobeJson
} from './ffprobeParse'

describe('recordedUtcFromTags', () => {
  it("reads an iPhone clip's capture date (its local time and offset) as UTC", () => {
    // The tags of the owner's IMG_1594.MOV (2026-08-02 race finish).
    const tags = {
      creation_time: '2026-08-02T13:57:01.000000Z',
      'com.apple.quicktime.creationdate': '2026-08-02T09:57:01-0400'
    }
    expect(recordedUtcFromTags(tags)).toBe('2026-08-02T13:57:01.000Z')
  })

  it('falls back to creation_time, and says null when nothing usable is there', () => {
    expect(recordedUtcFromTags({ creation_time: '2026-05-24T13:00:30.000000Z' })).toBe('2026-05-24T13:00:30.000Z')
    expect(recordedUtcFromTags({ 'com.apple.quicktime.creationdate': 'garbage', encoder: 'x' })).toBeNull()
    expect(recordedUtcFromTags(undefined)).toBeNull()
  })
})

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

describe('parseFfprobeJson — alpha channel detection', () => {
  const withPixFmt = (pix_fmt: string): FfprobeJson => ({
    streams: [{ codec_type: 'video', codec_name: 'vp9', width: 1080, height: 1920, pix_fmt }],
    format: { duration: '5.0', format_name: 'matroska,webm' }
  })
  it('flags alpha for yuva420p (background-removed clips)', () => {
    expect(parseFfprobeJson(withPixFmt('yuva420p')).video?.hasAlpha).toBe(true)
  })
  it('does not flag alpha for ordinary yuv420p footage', () => {
    expect(parseFfprobeJson(withPixFmt('yuv420p')).video?.hasAlpha).toBe(false)
  })
  it('flags alpha via the alpha_mode stream tag — real ffprobe reports yuv420p for VP9-alpha WebM', () => {
    const json = withPixFmt('yuv420p')
    json.streams![0].tags = { alpha_mode: '1' }
    expect(parseFfprobeJson(json).video?.hasAlpha).toBe(true)
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

describe('parseFfprobeJson — iPhone JPEG, EXIF orientation only on the first frame', () => {
  // Captured from IMG_8432.JPG (iPhone 14 Pro, upright portrait) with the
  // probe's own args, trimmed: the stream has no rotation; the frame does.
  const json: FfprobeJson = {
    frames: [
      {
        side_data_list: [
          { side_data_type: 'ICC profile' },
          { side_data_type: '3x3 displaymatrix', rotation: -90 },
          { side_data_type: 'EXIF metadata' }
        ]
      }
    ],
    streams: [
      {
        codec_type: 'video',
        codec_name: 'mjpeg',
        width: 4032,
        height: 3024,
        pix_fmt: 'yuvj420p',
        avg_frame_rate: '25/1',
        r_frame_rate: '25/1'
      }
    ],
    format: { duration: '0.040000', format_name: 'image2' }
  }

  it('reports the oriented (portrait) display size and keeps the stored size', () => {
    const v = parseFfprobeJson(json).video!
    expect({ w: v.width, h: v.height }).toEqual({ w: 4032, h: 3024 })
    expect({ w: v.displayWidth, h: v.displayHeight, rot: v.rotationDeg }).toEqual({ w: 3024, h: 4032, rot: 270 })
  })
  it('swaps for every quarter-turn orientation, mirrored ones included (EXIF 5–8 → ±90)', () => {
    for (const rotation of [90, -90]) {
      const v = parseFfprobeJson({
        ...json,
        frames: [{ side_data_list: [{ side_data_type: '3x3 displaymatrix', rotation }] }]
      }).video!
      expect({ w: v.displayWidth, h: v.displayHeight }).toEqual({ w: 3024, h: 4032 })
    }
  })
  it('does not swap for upside-down or mirrored-only orientations (EXIF 2–4 → 0/±180)', () => {
    for (const rotation of [0, 180, -180]) {
      const v = parseFfprobeJson({
        ...json,
        frames: [{ side_data_list: [{ side_data_type: '3x3 displaymatrix', rotation }] }]
      }).video!
      expect({ w: v.displayWidth, h: v.displayHeight }).toEqual({ w: 4032, h: 3024 })
    }
  })
  it('a frame with no display matrix (no EXIF orientation) stays as stored', () => {
    const v = parseFfprobeJson({ ...json, frames: [{ side_data_list: [{ side_data_type: 'ICC profile' }] }] }).video!
    expect({ w: v.displayWidth, h: v.displayHeight, rot: v.rotationDeg }).toEqual({ w: 4032, h: 3024, rot: 0 })
  })
  it("the stream's own rotation wins over the frame's", () => {
    const withStream: FfprobeJson = {
      ...json,
      streams: [{ ...json.streams![0], side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }] }]
    }
    expect(parseFfprobeJson(withStream).video!.rotationDeg).toBe(180)
  })
  it('stamps the probe version', () => {
    expect(parseFfprobeJson(json).version).toBe(PROBE_VERSION)
  })
})

describe('needsReprobe', () => {
  const probe = (version?: number): ProbeInfo => ({ ...parseFfprobeJson({ streams: [] }), version })
  it('re-probes images saved before orientation was read', () => {
    expect(needsReprobe({ kind: 'image', probe: probe(undefined) })).toBe(true)
    expect(needsReprobe({ kind: 'image', probe: probe(1) })).toBe(true)
  })
  it('leaves current images and every video/audio record alone', () => {
    expect(needsReprobe({ kind: 'image', probe: probe(PROBE_VERSION) })).toBe(false)
    expect(needsReprobe({ kind: 'video', probe: probe(undefined) })).toBe(false)
    expect(needsReprobe({ kind: 'audio', probe: probe(undefined) })).toBe(false)
  })
})
