/** Timeline ▸ pure helpers: row packing for the audio bands, snap targets, the time-code label. */

import type { AudioClip, Layer } from '@shared/project'
import { audioClipEnd } from '@shared/project'
import { type MediaAsset } from '@shared/media'
import { packRows, type Span } from '@/lib/lanes'
import { refKey } from '@/lib/links'

export const spanOf = (l: { id: string; startSec: number; endSec: number }): Span => ({
  id: l.id,
  startSec: l.startSec,
  endSec: l.endSec
})
/** Row packing for an audio band (a whole-source clip ends at its source's length). */
export function packAudioRows(clips: AudioClip[], assetById: Map<string, MediaAsset>): Map<string, number> {
  return packRows(
    clips.map((a) => ({
      id: a.id,
      startSec: a.startSec,
      endSec: audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)
    }))
  )
}
/** Snap targets: layer + audio boundaries, 0 and the end. `skip` (ref keys)
 *  drops the tiles currently being dragged, so a moving group never snaps to
 *  its own members. */
export function snapTargetsFor(
  layers: Layer[],
  audioClips: AudioClip[],
  assetById: Map<string, MediaAsset>,
  total: number,
  skip?: Set<string>
): number[] {
  const t = new Set<number>([0, total])
  for (const l of layers) {
    if (skip?.has(refKey({ kind: 'layer', id: l.id }))) continue
    t.add(l.startSec)
    t.add(l.endSec)
  }
  for (const a of audioClips) {
    if (skip?.has(refKey({ kind: 'audio', id: a.id }))) continue
    t.add(a.startSec)
    t.add(audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec))
  }
  return [...t]
}
export function tc(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const rem = (s % 60).toFixed(1)
  return `${m}:${rem.padStart(4, '0')}`
}
