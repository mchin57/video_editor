/**
 * Merge clips (Library ▸ right-click ▸ Merge clips…, Quick cut ▸ Save as one
 * clip, and the assistant's `merge_clips`): join windows of one or more
 * library videos, in the order given, into ONE new clip saved to the project's
 * `generated/`. The sources and the timeline are left alone.
 *
 * A merge is a list of SEGMENTS: a library clip and a source window of it.
 * Unlike Quick cut's pieces they may come from different clips and play in any
 * order (the same window may even repeat).
 *
 * Pure: the checks, the output's shape (`mergePlan`), the name and the
 * transcript carry-over live here so main and the renderer agree.
 */

import type { VideoStreamInfo } from './media'
import type { CaptionWord } from './project'
import { cutDisplayNames, sliceWords, MIN_CUT_SEC } from './quickCut'

export interface MergeSegment {
  mediaId: string
  /** Source second the segment starts at (inclusive). */
  inSec: number
  /** Source second the segment ends at (exclusive). */
  outSec: number
}

/** A merge joins at least this many segments (one is just a Quick cut). */
export const MIN_MERGE_SEGMENTS = 2

const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** Why a merge can't be made, or null when it can. `durationOf` gives each
 *  segment's source length. Checked by main before any encode. */
export function mergeProblem(segments: MergeSegment[], durationOf: (mediaId: string) => number): string | null {
  if (segments.length < MIN_MERGE_SEGMENTS) return `Pick at least ${MIN_MERGE_SEGMENTS} clips to merge.`
  for (const [i, s] of segments.entries()) {
    const n = ` (clip ${i + 1})`
    if (!Number.isFinite(s.inSec) || !Number.isFinite(s.outSec)) return `The times must be numbers${n}.`
    if (s.inSec < 0) return `The start can't be before 0s${n}.`
    const dur = r3(durationOf(s.mediaId))
    if (s.outSec > dur + 0.001) return `The end can't be after the clip's ${dur}s${n}.`
    if (s.outSec - s.inSec < MIN_CUT_SEC - 1e-9) return `Each clip must be at least ${MIN_CUT_SEC}s long${n}.`
  }
  return null
}

/** Total length of the merged clip, in seconds. */
export const mergedSec = (segments: Pick<MergeSegment, 'inSec' | 'outSec'>[]): number =>
  r3(segments.reduce((s, p) => s + p.outSec - p.inSec, 0))

/**
 * The merged clip's display name. Windows of ONE clip joined back together are
 * a cut of it (`IMG_1 (cut).mp4`, as Quick cut names a single piece); clips
 * from several sources take the first one's name: `IMG_1 (merged).mp4`.
 */
export function mergeDisplayName(fileNames: string[], sameSource: boolean, ext: string): string {
  if (sameSource) return cutDisplayNames(fileNames[0], 1, ext)[0]
  const dot = fileNames[0].lastIndexOf('.')
  const stem = dot > 0 ? fileNames[0].slice(0, dot) : fileNames[0]
  return `${stem} (merged).${ext}`
}

/**
 * The merged clip's transcript words: each segment's words (sliced and
 * re-timed as Quick cut does), shifted to where the segment starts in the
 * merge. `wordsOf` gives a segment's source words: [] for a clip without
 * audio, null when a clip with audio has no transcript — then the merge has
 * none either (half a transcript would caption only some of the speech).
 */
export function mergeWords(
  segments: MergeSegment[],
  wordsOf: (s: MergeSegment) => CaptionWord[] | null
): CaptionWord[] | null {
  const out: CaptionWord[] = []
  let at = 0
  for (const s of segments) {
    const words = wordsOf(s)
    if (!words) return null
    const start = Number(r3(s.inSec))
    for (const w of sliceWords(words, { inSec: start, outSec: s.outSec })) {
      out.push({ ...w, startSec: r3(w.startSec + at), endSec: r3(w.endSec + at) })
    }
    at += s.outSec - start
  }
  return out
}

/**
 * How the merged picture is made:
 *  - 'alpha' — any segment is transparent (a background-removed clip): VP9
 *    WebM with alpha; opaque clips stay opaque, letterbox bars are clear.
 *  - 'hdr'   — every segment is HDR with the same transfer: kept as it is
 *    (10-bit HEVC with the first clip's tags).
 *  - 'sdr'   — otherwise. HDR segments in a mix are tone-mapped to SDR.
 */
export type MergeMode = 'alpha' | 'hdr' | 'sdr'

export interface MergePlan {
  mode: MergeMode
  /** Output size: the first segment's display size (even). Others fit inside it. */
  width: number
  height: number
  /** Constant output frame rate: the fastest source's, 24–60. */
  fps: number
  /** Whether segment i is tone-mapped to SDR. */
  toneMap: boolean[]
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

export function mergePlan(videos: VideoStreamInfo[]): MergePlan {
  const first = videos[0]
  const mode: MergeMode = videos.some((v) => v.hasAlpha)
    ? 'alpha'
    : videos.every((v) => v.isHdr && v.colorTransfer === first.colorTransfer)
      ? 'hdr'
      : 'sdr'
  const fps = Math.min(60, Math.max(24, ...videos.map((v) => Math.round(v.avgFps || 30))))
  return {
    mode,
    width: even(first.displayWidth),
    height: even(first.displayHeight),
    fps,
    toneMap: videos.map((v) => mode !== 'hdr' && v.isHdr)
  }
}
