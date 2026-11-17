/**
 * The mark-keyframe diamonds drawn on a selected graphics tile (`components/
 * timeline/MarkKeyframes.tsx`): where a keyframe sits on the tile, which ones
 * are on it, and which one is under the playhead. Pure; the keyframes
 * themselves and their edits come from `shared/markAnim.ts`. Unit-tested
 * (`markKeyframes.test.ts`).
 */

import type { MarkKeyframe } from '@shared/markAnim'

/** How close (s) the playhead must be to a keyframe for it to count as "at" it. */
export const AT_PLAYHEAD_SEC = 0.02

/** The diamond's own box (px) and its rotated (45 deg) visual extent. */
export const DIAMOND_PX = 9
export const DIAMOND_EXTENT_PX = Math.ceil(DIAMOND_PX * Math.SQRT2)

/** A keyframe picked on a graphics tile (Delete removes just it). Identified by
 *  its layer, mark and time, so a pick that no longer matches is stale. */
export interface PickedMarkKeyframe {
  layerId: string
  markId: string
  tSec: number
}

/** The index of the picked keyframe in its mark's list, or -1 when the pick is
 *  stale (layer/mark gone, mark no longer keyframed, nothing at that time). */
export function pickedKeyframeIndex(
  comp: { layers: readonly { id: string; content: unknown }[] },
  pick: PickedMarkKeyframe | null
): number {
  if (!pick) return -1
  const layer = comp.layers.find((l) => l.id === pick.layerId)
  const content = layer?.content as { kind?: string; marks?: { id: string; keyframes?: MarkKeyframe[] }[] } | undefined
  if (content?.kind !== 'graphics') return -1
  const kfs = content.marks?.find((m) => m.id === pick.markId)?.keyframes
  return (kfs ?? []).findIndex((k) => Math.abs(k.tSec - pick.tSec) < 1e-9)
}

/** Where a diamond is DRAWN: its true x clamped so the whole diamond (`size`
 *  px across) plus 1 px stays inside a tile `tileWidth` wide. The true time
 *  is untouched; only the picture moves. */
export function clampKeyframeX(x: number, tileWidth: number, size: number = DIAMOND_EXTENT_PX): number {
  const half = size / 2 + 1
  if (tileWidth <= 2 * half) return tileWidth / 2
  return Math.min(Math.max(x, half), tileWidth - half)
}

/** Smallest gap (s) a dragged keyframe keeps from its neighbours (just over
 *  `shared/markAnim.ts`'s 0.02 s "same keyframe" window). */
export const KEYFRAME_GAP_SEC = 0.03

/** `tSec` held between keyframe `index`'s neighbours (in a time-sorted list),
 *  `KEYFRAME_GAP_SEC` short of each, so a drag never crosses or lands on one. */
export function clampBetweenNeighbours(kfs: readonly MarkKeyframe[], index: number, tSec: number): number {
  const lo = index > 0 ? kfs[index - 1].tSec + KEYFRAME_GAP_SEC : -Infinity
  const hi = index < kfs.length - 1 ? kfs[index + 1].tSec - KEYFRAME_GAP_SEC : Infinity
  return Math.min(Math.max(tSec, lo), Math.max(lo, hi))
}

/** A keyframe's x on the tile (px from its left edge). */
export const keyframeX = (tSec: number, pxPerSec: number): number => tSec * pxPerSec

/** The layer-local second under an x on the tile (px from its left edge). */
export const xToKeyframeSec = (x: number, pxPerSec: number): number => x / pxPerSec

/** The keyframes that fall on the tile (`tSec` within [0, `lenSec`]), each with
 *  its index in `kfs` — the index every edit (`retimeMarkKeyframe`,
 *  `removeMarkKeyframe`) takes. */
export function visibleKeyframes(
  kfs: readonly MarkKeyframe[] | undefined,
  lenSec: number
): { index: number; tSec: number }[] {
  const out: { index: number; tSec: number }[] = []
  ;(kfs ?? []).forEach((k, index) => {
    if (k.tSec >= 0 && k.tSec <= lenSec) out.push({ index, tSec: k.tSec })
  })
  return out
}

/** Index of the keyframe the playhead (layer-local `localSec`) is on, nearest
 *  within `AT_PLAYHEAD_SEC`; -1 if none. */
export function keyframeAtPlayhead(kfs: readonly MarkKeyframe[] | undefined, localSec: number): number {
  let best = -1
  let bestD = Infinity
  ;(kfs ?? []).forEach((k, i) => {
    const d = Math.abs(k.tSec - localSec)
    if (d <= AT_PLAYHEAD_SEC && d < bestD) {
      best = i
      bestD = d
    }
  })
  return best
}
