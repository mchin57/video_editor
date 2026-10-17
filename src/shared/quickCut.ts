/**
 * Quick cut (Library ▸ right-click ▸ Quick cut…, and the assistant's
 * `trim_clip` / `split_clip`): cut a library clip into one or more new clips,
 * each saved to the project's `generated/` as its own library item. The
 * original and every timeline placement of it are left alone.
 *
 * A cut is a list of PIECES — source windows of the original, in source
 * seconds, sorted and non-overlapping. Gaps between pieces are what was cut
 * away. Each piece becomes one file covering the source frames whose
 * timestamps fall in [inSec, outSec) (docs/FFMPEG-NOTES.md "Quick cut").
 *
 * Pure: the dialog's editing operations, the assistant's argument checks and
 * the transcript carry-over all live here, so both sides agree.
 */

import type { CaptionWord } from './project'

export interface CutPiece {
  /** Source second the piece starts at (inclusive). */
  inSec: number
  /** Source second the piece ends at (exclusive). */
  outSec: number
}

/** The shortest piece a cut may leave — a few frames, so a stray click can't
 *  make an empty file. */
export const MIN_CUT_SEC = 0.1

const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** The whole clip as one piece: where the dialog starts. */
export function wholeClip(durationSec: number): CutPiece[] {
  return [{ inSec: 0, outSec: r3(durationSec) }]
}

/** Whether a cut would produce exactly the original (nothing to save). */
export function isUncut(pieces: CutPiece[], durationSec: number): boolean {
  return pieces.length === 1 && pieces[0].inSec <= 0 && pieces[0].outSec >= r3(durationSec)
}

/** Why a cut can't be made, or null when it can. Checked by main before any encode. */
export function cutProblem(pieces: CutPiece[], durationSec: number): string | null {
  if (!pieces.length) return 'A cut needs at least one clip.'
  let prevOut = 0
  for (const [i, p] of pieces.entries()) {
    const n = pieces.length > 1 ? ` (clip ${i + 1})` : ''
    if (!Number.isFinite(p.inSec) || !Number.isFinite(p.outSec)) return `The cut times must be numbers${n}.`
    if (p.inSec < 0) return `The start can't be before 0s${n}.`
    if (p.outSec > r3(durationSec) + 0.001) return `The end can't be after the clip's ${r3(durationSec)}s${n}.`
    if (p.outSec - p.inSec < MIN_CUT_SEC - 1e-9) return `Each clip must be at least ${MIN_CUT_SEC}s long${n}.`
    if (i > 0 && p.inSec < prevOut - 1e-9) return 'The clips overlap or are out of order.'
    prevOut = p.outSec
  }
  return null
}

/** `trim_clip`: keep [startSec, endSec) of the clip. Throws with the reason. */
export function trimPieces(durationSec: number, startSec: number, endSec: number): CutPiece[] {
  const pieces = [{ inSec: r3(startSec), outSec: r3(Math.min(endSec, durationSec)) }]
  if (endSec <= startSec) throw new Error(`The end (${endSec}s) must be after the start (${startSec}s).`)
  const problem = cutProblem(pieces, durationSec)
  if (problem) throw new Error(problem)
  return pieces
}

/** `split_clip`: cut the whole clip at every given source second, giving
 *  `times.length + 1` back-to-back pieces. Throws with the reason. */
export function splitPieces(durationSec: number, times: number[]): CutPiece[] {
  if (!times.length) throw new Error('Give at least one split time.')
  const sorted = [...new Set(times.map(r3))].sort((a, b) => a - b)
  const bad = sorted.find((t) => !(t > 0 && t < durationSec))
  if (bad !== undefined) throw new Error(`Split time ${bad}s is not inside the clip (0–${r3(durationSec)}s).`)
  const edges = [0, ...sorted, r3(durationSec)]
  const pieces = edges.slice(1).map((outSec, i) => ({ inSec: edges[i], outSec }))
  const short = pieces.findIndex((p) => p.outSec - p.inSec < MIN_CUT_SEC - 1e-9)
  if (short >= 0) {
    throw new Error(
      `Clip ${short + 1} (${pieces[short].inSec}–${pieces[short].outSec}s) would be shorter than ${MIN_CUT_SEC}s.`
    )
  }
  return pieces
}

// ── The dialog's editing operations. Each returns the new pieces, or null when
//    the edit isn't possible (the caller leaves the cut unchanged). ──

/** Index of the piece that plays at `sec`, or -1 in a gap / past the end. */
export function pieceAt(pieces: CutPiece[], sec: number): number {
  return pieces.findIndex((p) => sec >= p.inSec && sec < p.outSec)
}

/** Where playback of the cut continues from `sec`: `sec` itself inside a piece,
 *  else the start of the next piece; null past the last one. The dialog's
 *  preview plays only what will be saved, jumping the gaps. */
export function playFrom(pieces: CutPiece[], sec: number): number | null {
  if (pieceAt(pieces, sec) >= 0) return sec
  return pieces.find((p) => p.inSec >= sec)?.inSec ?? null
}

/** Split the piece under `sec` in two there. Null in a gap, or when either half
 *  would be shorter than MIN_CUT_SEC. */
export function splitPieceAt(pieces: CutPiece[], sec: number): CutPiece[] | null {
  const at = r3(sec)
  const i = pieceAt(pieces, at)
  if (i < 0) return null
  const p = pieces[i]
  if (at - p.inSec < MIN_CUT_SEC || p.outSec - at < MIN_CUT_SEC) return null
  return [
    ...pieces.slice(0, i),
    { inSec: p.inSec, outSec: at },
    { inSec: at, outSec: p.outSec },
    ...pieces.slice(i + 1)
  ]
}

/** Remove piece `index`. Null for the last remaining piece: a cut never has zero clips. */
export function deletePiece(pieces: CutPiece[], index: number): CutPiece[] | null {
  if (pieces.length <= 1 || index < 0 || index >= pieces.length) return null
  return pieces.filter((_, i) => i !== index)
}

/**
 * Move one edge of piece `index` to `sec`, clamped so the piece stays at least
 * MIN_CUT_SEC long and never crosses its neighbours (or 0 / the clip's end).
 * A trim can grow a piece back into a gap left by a trim or a delete.
 */
export function trimPieceEdge(
  pieces: CutPiece[],
  index: number,
  edge: 'in' | 'out',
  sec: number,
  durationSec: number
): CutPiece[] {
  const p = pieces[index]
  if (!p) return pieces
  const next = [...pieces]
  if (edge === 'in') {
    const lo = index > 0 ? pieces[index - 1].outSec : 0
    next[index] = { ...p, inSec: r3(Math.min(Math.max(sec, lo), p.outSec - MIN_CUT_SEC)) }
  } else {
    const hi = index < pieces.length - 1 ? pieces[index + 1].inSec : r3(durationSec)
    next[index] = { ...p, outSec: r3(Math.max(Math.min(sec, hi), p.inSec + MIN_CUT_SEC)) }
  }
  return next
}

/** Total length the cut keeps, in seconds. */
export const keptSec = (pieces: CutPiece[]): number => r3(pieces.reduce((s, p) => s + p.outSec - p.inSec, 0))

/**
 * Display names for the new clips: `IMG_1 (cut).mp4` for a single piece,
 * `IMG_1 (cut 1).mp4`, `(cut 2)`, … for several. `ext` is the OUTPUT's
 * extension (a cut is re-encoded, so it may differ from the original's).
 */
export function cutDisplayNames(fileName: string, count: number, ext: string): string[] {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  if (count === 1) return [`${stem} (cut).${ext}`]
  return Array.from({ length: count }, (_, i) => `${stem} (cut ${i + 1}).${ext}`)
}

/**
 * The original's transcript words that belong to a piece, re-timed to the new
 * clip (t = 0 at the piece's start), so captions work on a cut without running
 * whisper again. A word belongs to the piece holding its midpoint; a word
 * straddling an edge is clamped to it.
 */
export function sliceWords(words: CaptionWord[], piece: CutPiece): CaptionWord[] {
  const len = piece.outSec - piece.inSec
  return words
    .filter((w) => {
      const mid = (w.startSec + w.endSec) / 2
      return mid >= piece.inSec && mid < piece.outSec
    })
    .map((w) => ({
      ...w,
      startSec: r3(Math.max(0, w.startSec - piece.inSec)),
      endSec: r3(Math.min(len, w.endSec - piece.inSec))
    }))
}
