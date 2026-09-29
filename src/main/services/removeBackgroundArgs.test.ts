import { describe, it, expect } from 'vitest'
import {
  buildMatteDecodeArgs,
  buildMatteEncodeArgs,
  compositeRgba,
  downsampleRatioFor,
  frameToSrcTensor,
  matteDims,
  matteFps,
  rawFrames
} from './removeBackgroundArgs'

describe('matteDims', () => {
  it('keeps Reel-native size and stays even', () => {
    expect(matteDims(1080, 1920)).toEqual({ w: 1080, h: 1920 })
  })
  it('caps the longest edge and never upscales', () => {
    expect(matteDims(3840, 2160)).toEqual({ w: 1920, h: 1080 })
    expect(matteDims(640, 360)).toEqual({ w: 640, h: 360 })
  })
})

describe('matteFps', () => {
  it('mattes at most the 30 fps the export renders, at normal speed', () => {
    expect(matteFps(60)).toBe(30) // iPhone 60 fps: every other frame is enough
    expect(matteFps(59.94)).toBe(30)
    expect(matteFps(29.97)).toBe(30)
    expect(matteFps(24)).toBe(24) // never more than the source has
  })
  it('keeps more source frames for slow motion, up to what exists (≤ 60)', () => {
    expect(matteFps(60, 0.5)).toBe(60)
    expect(matteFps(30, 0.5)).toBe(30)
    expect(matteFps(120, 0.25)).toBe(60)
    expect(matteFps(60, 0.75)).toBe(40)
  })
  it('does not drop below the export rate for fast clips, and survives junk', () => {
    expect(matteFps(60, 2)).toBe(30)
    expect(matteFps(0)).toBe(30)
    expect(matteFps(60, Number.NaN)).toBe(30)
  })
})

describe('downsampleRatioFor', () => {
  it('targets a ~512px long edge, clamped to [0.25, 1]', () => {
    expect(downsampleRatioFor(1080, 1920)).toBeCloseTo(0.267, 2) // 512/1920
    expect(downsampleRatioFor(200, 200)).toBe(1) // small clip → no downsample
  })
})

describe('buildMatteDecodeArgs', () => {
  it('decodes upright rgb24 frames, setting the rate with the fps FILTER (not -r)', () => {
    const args = buildMatteDecodeArgs('in.mov', 1080, 1920, 30)
    const s = args.join(' ')
    expect(s).toContain('-vf fps=30,scale=1080:1920:flags=bicubic')
    expect(args).not.toContain('-r') // -r after an input seek mis-cadences 60→30 (FFMPEG-NOTES)
    expect(s).toContain('-pix_fmt rgb24')
    expect(args[args.length - 1]).toBe('pipe:1')
  })
  it('folds an HDR prefilter after the rate change and before the scale', () => {
    const s = buildMatteDecodeArgs('in.mov', 1080, 1920, 30, 'zscaleX').join(' ')
    expect(s).toContain('-vf fps=30,zscaleX,scale=1080:1920:flags=bicubic')
  })
  it('seeks the decode to ONLY the layer window — -ss/-t before -i', () => {
    const args = buildMatteDecodeArgs('in.mov', 1080, 1920, 30, '', { startSec: 12.5, durationSec: 8 })
    const i = args.indexOf('-i')
    expect(args.slice(i - 4, i)).toEqual(['-ss', '12.500', '-t', '8.000'])
    expect(args[i + 1]).toBe('in.mov')
  })
  it('reads the whole source when no window is given', () => {
    expect(buildMatteDecodeArgs('in.mov', 1080, 1920, 30)).not.toContain('-ss')
  })
})

describe('buildMatteEncodeArgs', () => {
  it('encodes stdin rgba into a silent VP9 yuva420p WebM', () => {
    const s = buildMatteEncodeArgs('out.webm', 1080, 1920, 30)
    const j = s.join(' ')
    expect(j).toContain('-f rawvideo -pix_fmt rgba -s 1080x1920 -r 30 -i pipe:0')
    expect(j).toContain('libvpx-vp9')
    expect(j).toContain('yuva420p')
    expect(s).toContain('-an')
    expect(s[s.length - 1]).toBe('out.webm')
  })
  it("muxes the same window's audio from the source as Opus", () => {
    const s = buildMatteEncodeArgs('out.webm', 1080, 1920, 30, {
      input: 'src.mov',
      window: { startSec: 12.5, durationSec: 8 }
    })
    const j = s.join(' ')
    expect(j).toContain('-i pipe:0 -ss 12.500 -t 8.000 -i src.mov -map 0:v:0 -map 1:a:0')
    expect(j).toContain('-c:a libopus -b:a 192k')
    expect(s).not.toContain('-an')
    expect(s[s.length - 1]).toBe('out.webm')
  })
})

describe('rawFrames', () => {
  async function* chunked(bytes: number[], sizes: number[]): AsyncGenerator<Uint8Array> {
    let at = 0
    for (const n of sizes) {
      yield Uint8Array.from(bytes.slice(at, at + n))
      at += n
    }
  }
  it('reassembles frames across arbitrary chunk boundaries and drops a trailing partial', async () => {
    const bytes = Array.from({ length: 11 }, (_, i) => i) // 2 frames of 4 + 3 leftover
    const frames: number[][] = []
    for await (const f of rawFrames(chunked(bytes, [3, 2, 5, 1]), 4)) frames.push(Array.from(f))
    expect(frames).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7]
    ])
  })
  it('yields several frames out of one big chunk, reusing one buffer', async () => {
    const seen: Uint8Array[] = []
    const values: number[][] = []
    for await (const f of rawFrames(chunked([9, 8, 7, 6, 5, 4], [6]), 2)) {
      seen.push(f)
      values.push(Array.from(f)) // consume before the next iteration overwrites it
    }
    expect(values).toEqual([
      [9, 8],
      [7, 6],
      [5, 4]
    ])
    expect(new Set(seen).size).toBe(1)
  })
})

describe('RVM frame tensor round-trip', () => {
  it('packs rgb24 HWC pixels into CHW [0,1] planes', () => {
    // 2 pixels: (255,0,0) then (0,128,255)
    const rgb = new Uint8Array([255, 0, 0, 0, 128, 255])
    const t = frameToSrcTensor(rgb, 2, 1)
    expect(Array.from(t.slice(0, 2))).toEqual([1, 0]) // R plane
    expect(t[2]).toBe(0)
    expect(t[3]).toBeCloseTo(128 / 255, 5) // G plane
    expect(t[4]).toBe(0)
    expect(t[5]).toBeCloseTo(1, 6) // B plane
  })
  it('fills a caller-owned buffer when given one', () => {
    const out = new Float32Array(6)
    const t = frameToSrcTensor(new Uint8Array([255, 255, 255, 0, 0, 0]), 2, 1, out)
    expect(t).toBe(out)
    expect(out[0]).toBeCloseTo(1, 6)
    expect(out[1]).toBe(0)
  })
  it('composites foreground + alpha into straight-alpha RGBA bytes', () => {
    const fgr = new Float32Array([1, 0, 0, 0.5, 0, 1]) // CHW for 2 px
    const pha = new Float32Array([1, 0]) // px0 opaque, px1 transparent
    const out = compositeRgba(fgr, pha, 2, 1)
    expect(out).toBeInstanceOf(Uint8Array)
    expect(Array.from(out.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(out.slice(4, 8))).toEqual([0, 128, 255, 0])
  })
  it('clamps out-of-range model output (and NaN) into bytes', () => {
    const out = compositeRgba(new Float32Array([1.7, -0.2, Number.NaN]), new Float32Array([2]), 1, 1)
    expect(Array.from(out)).toEqual([255, 0, 0, 255])
  })
})
