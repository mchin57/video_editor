/**
 * The volume line drawn on a selected audio tile (`components/timeline/
 * VolumeLine.tsx`): where a level sits vertically, the polyline that draws the
 * line, and resolving a picked point. Pure; the line's VALUES come from
 * `shared/audioEnvelope.ts` (the preview/export envelope) — this only maps them
 * onto the tile. Unit-tested (`volumeLine.test.ts`).
 */

import type { AudioClip, Composition } from '@shared/project'
import {
  VOLUME_LINE_MAX_DB,
  VOLUME_LINE_SILENCE_DB,
  clipLinePoints,
  lineDbAt,
  sortedVolumeKeyframes
} from '@shared/audioEnvelope'

/** Shortest lane row (px) that shows the line on a selected tile — the default
 *  row (26 px) does; a squashed lane leaves the tile to moving and trimming. */
export const MIN_VOLUME_LINE_ROW_H = 24

/** Where 0 dB sits, as a fraction of the tile height from the top. */
const ZERO_AT = 0.25
/** Below 0 dB the drop follows amplitude (10^(dB/40)), so a −6 dB dip reads as
 *  a real dip instead of a sliver of a −60 … +12 dB scale. */
const FLOOR_AMP = Math.pow(10, VOLUME_LINE_SILENCE_DB / 40)

/** A level's height on the tile: 0 = top (+12 dB), 1 = bottom (silence). */
export function dbToFrac(db: number): number {
  if (db >= 0) return ZERO_AT * (1 - Math.min(db, VOLUME_LINE_MAX_DB) / VOLUME_LINE_MAX_DB)
  const amp = Math.pow(10, Math.max(db, VOLUME_LINE_SILENCE_DB) / 40)
  return ZERO_AT + (1 - ZERO_AT) * ((1 - amp) / (1 - FLOOR_AMP))
}

/** The inverse of `dbToFrac` (clamped to the tile). */
export function fracToDb(frac: number): number {
  const f = Math.min(1, Math.max(0, frac))
  if (f <= ZERO_AT) return VOLUME_LINE_MAX_DB * (1 - f / ZERO_AT)
  const amp = 1 - ((f - ZERO_AT) / (1 - ZERO_AT)) * (1 - FLOOR_AMP)
  return amp <= FLOOR_AMP ? VOLUME_LINE_SILENCE_DB : Math.max(VOLUME_LINE_SILENCE_DB, 40 * Math.log10(amp))
}

/** The tile-local x (px) of SOURCE second `sourceSec`. */
export function sourceToX(clip: Pick<AudioClip, 'inSec'>, sourceSec: number, pxPerSec: number): number {
  return (sourceSec - clip.inSec) * pxPerSec
}

/** The SOURCE second at tile-local x (px). */
export function xToSource(clip: Pick<AudioClip, 'inSec'>, x: number, pxPerSec: number): number {
  return clip.inSec + x / pxPerSec
}

/**
 * The SVG `points` of the line across the tile (`widthPx` × `heightPx`):
 * straight lines IN dB are curves on this scale, so each stretch is sampled
 * every ~`stepPx`, plus every point's own x. `outSec` = the clip's effective
 * source out-point.
 */
export function volumeLinePolyline(
  clip: AudioClip,
  outSec: number,
  pxPerSec: number,
  widthPx: number,
  heightPx: number,
  stepPx = 3
): string {
  const pts = clipLinePoints(clip, outSec)
  const xs = new Set<number>([0, widthPx])
  for (let x = stepPx; x < widthPx; x += stepPx) xs.add(x)
  for (const p of pts) {
    const x = (p.t - clip.startSec) * pxPerSec
    if (x > 0 && x < widthPx) xs.add(x)
  }
  return [...xs]
    .sort((a, b) => a - b)
    .map((x) => {
      const db = lineDbAt(pts, clip.startSec + x / pxPerSec)
      return `${x.toFixed(1)},${(dbToFrac(db) * heightPx).toFixed(1)}`
    })
    .join(' ')
}

/** A volume point picked on a tile (Delete removes it). Identified by its index
 *  in the SORTED list AND its source second, so a stale pick is simply none. */
export interface PickedVolumePoint {
  clipId: string
  index: number
  sourceSec: number
}

/** The picked point's index in its clip's sorted line, or -1 when the pick is
 *  stale (undone, moved, deleted) or its clip isn't in `comp`. */
export function pickedVolumePointIndex(comp: Pick<Composition, 'audioClips'>, pick: PickedVolumePoint): number {
  const clip = comp.audioClips.find((a) => a.id === pick.clipId)
  if (!clip) return -1
  const k = sortedVolumeKeyframes(clip)[pick.index]
  return k && Math.abs(k.sourceSec - pick.sourceSec) < 1e-6 ? pick.index : -1
}
