/**
 * Put a library clip on the timeline at `startSec` and select it: a picture as
 * a 3 s image layer, a sound as an audio clip, a video as a video layer (with
 * its audio as a LINKED partner, the whole group selected). ONE home for it —
 * the Library's add buttons, a drop on the timeline and the shared library's
 * Insert call this. Workouts are placed by `placeWorkout` (lib/workout.ts).
 */

import type { MediaAsset } from '@shared/media'
import { assetAspect, assetKind } from '@shared/media'
import { makeImageLayer } from '@shared/layers'
import { newId } from '@shared/ids'
import { getActiveComp, getFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'

/** How long a picture lasts when it is placed. */
export const IMAGE_PLACE_SEC = 3

/** Place `asset` at `startSec`; returns the new tile's id (null for a workout). */
export function placeAsset(asset: MediaAsset, startSec: number): string | null {
  const store = useProject.getState()
  const ui = useUi.getState()
  const id = newId()
  const kind = assetKind(asset)
  if (kind === 'workout') return null
  if (kind === 'image') {
    store.addLayer(
      makeImageLayer(id, asset.id, startSec, startSec + IMAGE_PLACE_SEC, {
        frame: getFormat().frame,
        aspect: assetAspect(asset)
      })
    )
    ui.selectLayer(id)
  } else if (kind === 'audio') {
    store.addAudioClip({
      id,
      mediaId: asset.id,
      startSec,
      inSec: 0,
      outSec: asset.probe.durationSec,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'audio'
    })
    ui.selectAudio(id)
  } else {
    store.addVideoLayer(id, asset.id, startSec, asset.probe.durationSec, !!asset.probe.audio, assetAspect(asset))
    // A clip with audio lands as a LINKED pair — select the whole group.
    ui.selectTile(getActiveComp(), { kind: 'layer', id })
  }
  return id
}
