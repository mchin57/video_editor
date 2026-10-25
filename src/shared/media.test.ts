import { describe, it, expect } from 'vitest'
import {
  alphaInputDecoder,
  assetKind,
  DESCRIPTION_MAX,
  kindOfFile,
  normalizeDescription,
  pixFmtHasAlpha,
  reconcileKind,
  relinkKindProblem,
  type MediaAsset,
  type ProbeInfo,
  type VideoStreamInfo
} from './media'

describe('pixFmtHasAlpha', () => {
  it('recognises the alpha pixel-format families', () => {
    for (const f of ['yuva420p', 'yuva444p10le', 'ya8', 'gbrap', 'rgba', 'bgra', 'argb']) {
      expect(pixFmtHasAlpha(f)).toBe(true)
    }
  })
  it('rejects opaque formats and absent values', () => {
    for (const f of ['yuv420p', 'yuv422p10le', 'nv12', 'rgb24', 'gray', undefined, null, '']) {
      expect(pixFmtHasAlpha(f)).toBe(false)
    }
  })
})

describe('alphaInputDecoder', () => {
  const v = (codec: string, hasAlpha: boolean): { codec: string; hasAlpha: boolean } => ({ codec, hasAlpha })
  it('forces the libvpx decoders for VP8/VP9 alpha (native decode drops the side-band)', () => {
    expect(alphaInputDecoder(v('vp9', true))).toBe('libvpx-vp9')
    expect(alphaInputDecoder(v('vp8', true))).toBe('libvpx')
  })
  it('needs no forcing without alpha, or for codecs whose default decoder carries it', () => {
    expect(alphaInputDecoder(v('vp9', false))).toBeNull()
    expect(alphaInputDecoder(v('prores', true))).toBeNull() // ProRes 4444 decodes alpha natively
    expect(alphaInputDecoder(null)).toBeNull()
    expect(alphaInputDecoder(undefined)).toBeNull()
  })
})

describe('normalizeDescription', () => {
  it('folds Windows line endings, trims the ends and caps the length', () => {
    expect(normalizeDescription('  swim start\r\nwave 2  ')).toBe('swim start\nwave 2')
    expect(normalizeDescription(' \n ')).toBe('')
    expect(normalizeDescription('x'.repeat(DESCRIPTION_MAX + 50))).toHaveLength(DESCRIPTION_MAX)
  })
})

describe('media kind: extension checked against the probe', () => {
  const picture: VideoStreamInfo = {
    codec: 'h264',
    width: 1080,
    height: 1920,
    displayWidth: 1080,
    displayHeight: 1920,
    rotationDeg: 0,
    avgFps: 30,
    rFps: 30,
    isVfr: false,
    pixFmt: 'yuv420p',
    colorTransfer: null,
    colorPrimaries: null,
    colorSpace: null,
    isHdr: false
  }
  const sound = { codec: 'aac', sampleRate: 48000, channels: 2 }
  const probe = (p: Partial<ProbeInfo>): ProbeInfo => ({
    durationSec: 2,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: null,
    audio: null,
    ...p
  })

  it('an audio-only .mp4 (AAC, or an MP3 renamed .mp4) is audio, not video', () => {
    expect(kindOfFile('C:/a/song.mp4', probe({ audio: sound }))).toBe('audio')
    expect(kindOfFile('C:/a/renamed.MP4', probe({ container: 'mp3', audio: { ...sound, codec: 'mp3' } }))).toBe('audio')
    expect(kindOfFile('C:/a/voice.mov', probe({ audio: sound }))).toBe('audio')
  })

  it('a video with a picture stays video, with or without sound', () => {
    expect(kindOfFile('C:/a/clip.mp4', probe({ video: picture, audio: sound }))).toBe('video')
    expect(kindOfFile('C:/a/silent.mp4', probe({ video: picture }))).toBe('video')
  })

  it('a still renamed to a video extension is an image (one picture, no duration, no sound)', () => {
    // ffprobe on a JPEG renamed .mp4: format jpeg_pipe, codec mjpeg, no duration at all (#19).
    const still = { ...picture, codec: 'mjpeg', avgFps: 25, rFps: 25 }
    expect(kindOfFile('C:/a/photo.mp4', probe({ container: 'jpeg_pipe', durationSec: 0, video: still }))).toBe('image')
    expect(
      kindOfFile('C:/a/logo.mov', probe({ container: 'png_pipe', durationSec: 0, video: { ...still, codec: 'png' } }))
    ).toBe('image')
    // A picture with sound, or with a duration, is still a video.
    expect(kindOfFile('C:/a/clip.mp4', probe({ durationSec: 0, video: picture, audio: sound }))).toBe('video')
    expect(kindOfFile('C:/a/clip.mp4', probe({ durationSec: 0.04, video: picture }))).toBe('video')
  })

  it('an extension that probes to nothing keeps its claim (a failed or empty probe)', () => {
    expect(kindOfFile('C:/a/broken.mp4', probe({ durationSec: 0 }))).toBe('video')
  })

  it('audio and image extensions keep their class', () => {
    expect(kindOfFile('C:/a/song.m4a', probe({ audio: sound }))).toBe('audio')
    expect(kindOfFile('C:/a/cover.mp3', probe({ video: { ...picture, codec: 'mjpeg' }, audio: sound }))).toBe('audio')
    expect(kindOfFile('C:/a/photo.jpg', probe({ durationSec: 0.04, video: { ...picture, codec: 'mjpeg' } }))).toBe(
      'image'
    )
  })

  it('an unknown extension falls back to the probe', () => {
    expect(kindOfFile('C:/a/file.xyz', probe({ audio: sound }))).toBe('audio')
    expect(kindOfFile('C:/a/file.xyz', probe({ video: picture }))).toBe('video')
    expect(reconcileKind(null, probe({ video: picture, durationSec: 0 }))).toBe('image')
  })

  it('a record saved as video with no picture reads back as audio (saved before the fix)', () => {
    const saved = { kind: 'video', probe: probe({ audio: sound }) } as MediaAsset
    expect(assetKind(saved)).toBe('audio')
    expect(assetKind({ ...saved, probe: probe({ video: picture, audio: sound }) })).toBe('video')
  })

  it('a .fit file is a workout, and its probe (no streams) keeps it one', () => {
    const workout: ProbeInfo = {
      ...probe({}),
      container: 'fit',
      workout: { sport: 'cycling', startUtc: '', channels: [], distanceM: null, avgPowerW: null }
    }
    expect(kindOfFile('C:/rides/Morning Ride.FIT', workout)).toBe('workout')
    expect(reconcileKind(null, workout)).toBe('workout')
    expect(assetKind({ kind: 'workout', probe: workout } as MediaAsset)).toBe('workout')
    // The probe decides both ways: a workout probe under another claim, and a
    // workout claim over an ffprobe probe.
    expect(reconcileKind('video', workout)).toBe('workout')
    expect(reconcileKind('workout', probe({ video: picture, audio: sound }))).toBe('video')
  })

  it('a workout and footage are never relinked to each other', () => {
    const workout: ProbeInfo = {
      ...probe({}),
      workout: { sport: 'cycling', startUtc: '', channels: [], distanceM: null, avgPowerW: null }
    }
    const footage = probe({ video: picture, audio: sound })
    expect(relinkKindProblem({ kind: 'video', fileName: 'IMG_1.MOV' }, workout)).toMatch(/is a workout file/)
    expect(relinkKindProblem({ kind: 'workout', fileName: 'ride.fit' }, footage)).toMatch(
      /only be relinked to a workout/
    )
    expect(relinkKindProblem({ kind: 'video', fileName: 'IMG_1.MOV' }, footage)).toBeNull()
    expect(relinkKindProblem({ kind: 'workout', fileName: 'ride.fit' }, workout)).toBeNull()
  })
})
