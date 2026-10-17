import { describe, expect, it } from 'vitest'
import type { VideoStreamInfo } from './media'
import type { CaptionWord } from './project'
import { mergeDisplayName, mergedSec, mergePlan, mergeProblem, mergeWords, type MergeSegment } from './merge'

const dur = (id: string): number => ({ a: 10, b: 4 })[id] ?? 0
const seg = (mediaId: string, inSec: number, outSec: number): MergeSegment => ({ mediaId, inSec, outSec })

describe('mergeProblem', () => {
  it('needs at least two segments', () => {
    expect(mergeProblem([], dur)).toMatch(/at least 2/)
    expect(mergeProblem([seg('a', 0, 10)], dur)).toMatch(/at least 2/)
  })

  it('accepts any clips in any order, repeats included', () => {
    expect(mergeProblem([seg('b', 0, 4), seg('a', 5, 10), seg('a', 0, 2), seg('a', 0, 2)], dur)).toBeNull()
  })

  it('names the bad segment', () => {
    expect(mergeProblem([seg('a', 0, 1), seg('b', 0, 4.5)], dur)).toBe("The end can't be after the clip's 4s (clip 2).")
    expect(mergeProblem([seg('a', -1, 1), seg('b', 0, 1)], dur)).toMatch(/before 0s \(clip 1\)/)
    expect(mergeProblem([seg('a', 1, 1.05), seg('b', 0, 1)], dur)).toMatch(/at least 0.1s long \(clip 1\)/)
    expect(mergeProblem([seg('a', 0, NaN), seg('b', 0, 1)], dur)).toMatch(/numbers/)
  })
})

describe('mergeDisplayName / mergedSec', () => {
  it('one source joined back is a cut; several take the first name', () => {
    expect(mergeDisplayName(['IMG_1.MOV'], true, 'mp4')).toBe('IMG_1 (cut).mp4')
    expect(mergeDisplayName(['IMG_1.MOV', 'IMG_2.MOV'], false, 'mp4')).toBe('IMG_1 (merged).mp4')
    expect(mergeDisplayName(['clip (no bg).webm'], false, 'webm')).toBe('clip (no bg) (merged).webm')
  })

  it('totals the windows', () => {
    expect(mergedSec([seg('a', 0, 1.5), seg('b', 1, 2.25)])).toBe(2.75)
  })
})

describe('mergeWords', () => {
  const w = (text: string, startSec: number, endSec: number): CaptionWord => ({ text, startSec, endSec })
  const words: Record<string, CaptionWord[]> = {
    a: [w('one', 0.2, 0.6), w('two', 1.2, 1.6), w('three', 5.1, 5.5)],
    b: [w('hi', 0.5, 0.9)]
  }

  it('slices each window and shifts it to where it plays in the merge', () => {
    const out = mergeWords([seg('a', 1, 2), seg('b', 0, 1), seg('a', 5, 6)], (s) => words[s.mediaId])
    expect(out!.map((x) => [x.text, x.startSec, x.endSec])).toEqual([
      ['two', 0.2, 0.6],
      ['hi', 1.5, 1.9],
      ['three', 2.1, 2.5]
    ])
  })

  it('a clip without audio adds no words; a clip with audio but no transcript drops them all', () => {
    expect(mergeWords([seg('a', 1, 2), seg('b', 0, 1)], (s) => (s.mediaId === 'b' ? [] : words.a))!.length).toBe(1)
    expect(mergeWords([seg('a', 1, 2), seg('b', 0, 1)], (s) => (s.mediaId === 'b' ? null : words.a))).toBeNull()
  })
})

describe('mergePlan', () => {
  const v = (o: Partial<VideoStreamInfo> = {}): VideoStreamInfo => ({
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
    ...o
  })
  const hlg = { isHdr: true, colorTransfer: 'arib-std-b67', pixFmt: 'yuv420p10le', codec: 'hevc' }

  it("takes the first clip's display size (even) and the fastest frame rate, 24–60", () => {
    const p = mergePlan([v({ displayWidth: 721, displayHeight: 1281 }), v({ avgFps: 59.94 }), v({ avgFps: 120 })])
    expect([p.width, p.height, p.fps]).toEqual([720, 1280, 60])
    expect(mergePlan([v({ avgFps: 15 })]).fps).toBe(24)
  })

  it('alpha wins; all-HDR with one transfer stays HDR; a mix tone-maps the HDR clips', () => {
    expect(mergePlan([v(), v({ hasAlpha: true })]).mode).toBe('alpha')
    expect(mergePlan([v(hlg), v(hlg)])).toMatchObject({ mode: 'hdr', toneMap: [false, false] })
    expect(mergePlan([v(hlg), v()])).toMatchObject({ mode: 'sdr', toneMap: [true, false] })
    expect(mergePlan([v(hlg), v({ ...hlg, colorTransfer: 'smpte2084' })])).toMatchObject({
      mode: 'sdr',
      toneMap: [true, true]
    })
    expect(mergePlan([v(hlg), v({ hasAlpha: true })])).toMatchObject({ mode: 'alpha', toneMap: [true, false] })
  })
})
