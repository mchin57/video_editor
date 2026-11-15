/**
 * Put a library clip on the timeline at `startSec` and select it: a picture as
 * a 3 s image layer, a sound as an audio clip, a video as a video layer (with
 * its audio as a LINKED partner, the whole group selected). ONE home for it —
 * the Library's add buttons, a drop on the timeline and the shared library's
 * Insert call this. Workouts are placed by `placeWorkout` (lib/workout.ts).
 *
 * With `insert`, the clip is INSERTED: every other tile from `startSec` on
 * moves later by the clip's length (the store's `insertAt`; the rules are in
 * lib/ripple.ts), as one undo step with the add.
 */

import type { MediaAsset } from '@shared/media'
import { assetAspect, assetKind } from '@shared/media'
import { makeImageLayer } from '@shared/layers'
import { newId } from '@shared/ids'
import { getActiveComp, getFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'

/** How long a picture lasts when it is placed. */
export const IMAGE_PLACE_SEC = 3

/**
 * Whether a clip DROPPED on a seam is inserted there. A picture (video, image)
 * is: it takes its place in the sequence. A sound is not — it plays under the
 * picture, so dropping a music bed at the start must not push the edit later
 * by the length of the song; it is placed as it always was. (`placeAsset`'s
 * `insert` still inserts a sound when asked outright.)
 */
export function insertsOnDrop(asset: MediaAsset): boolean {
  const kind = assetKind(asset)
  return kind === 'video' || kind === 'image'
}

/** A second drag-payload type the Library adds for a clip that `insertsOnDrop`.
 *  A drag's DATA can't be read until the drop, but its types can — this is how
 *  the timeline knows, mid-drag, whether to show the insert caret. */
export const INSERT_DND_MIME = 'application/x-reel-insert'

/** Place `asset` at `startSec`; returns the new tile's id (null for a workout). */
export function placeAsset(asset: MediaAsset, startSec: number, opts: { insert?: boolean } = {}): string | null {
  const store = useProject.getState()
  const ui = useUi.getState()
  const id = newId()
  const kind = assetKind(asset)
  if (kind === 'workout') return null
  const add = (): void => {
    if (kind === 'image') {
      store.addLayer(
        makeImageLayer(id, asset.id, startSec, startSec + IMAGE_PLACE_SEC, {
          frame: getFormat().frame,
          aspect: assetAspect(asset)
        })
      )
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
    } else {
      store.addVideoLayer(id, asset.id, startSec, asset.probe.durationSec, !!asset.probe.audio, assetAspect(asset))
    }
  }
  if (opts.insert) store.insertAt(startSec, add)
  else add()
  if (kind === 'image') ui.selectLayer(id)
  else if (kind === 'audio') ui.selectAudio(id)
  // A clip with audio lands as a LINKED pair — select the whole group.
  else ui.selectTile(getActiveComp(), { kind: 'layer', id })
  return id
}
