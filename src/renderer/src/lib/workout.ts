/**
 * Placing a WORKOUT OVERLAY from the library (docs/WORKOUT-OVERLAY.md). Over a
 * video clip that was filmed during the workout, the overlay SYNCS: it covers
 * that clip's window at real time, showing the recording exactly as it was
 * while the clip was filmed, and is linked to the clip so they move together.
 * Anywhere else it shows the whole recording in `WHOLE_WORKOUT_SEC`.
 */

import type { MediaAsset } from '@shared/media'
import { makeWorkoutLayer } from '@shared/layers'
import { newId } from '@shared/ids'
import { defaultWidgets, syncCandidate, syncedWindow, WHOLE_WORKOUT_SEC } from '@shared/workoutOverlay'
import { createLogger } from '@shared/log'
import { mediaRecordedAt } from '@/ipc/client'
import { idle } from '@/lib/interaction'
import { getActiveComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'

const log = createLogger('workout')

/** The clip's recording time, or null (main answers null for a clip the editor
 *  made: `canSyncTo`) — a failed read places the whole-ride overlay instead of
 *  nothing. */
const recordedAt = (mediaId: string): Promise<string | null> =>
  mediaRecordedAt(mediaId).catch((error: unknown) => {
    log.warn(`reading the recording time of ${mediaId} failed`, error)
    return null
  })

/**
 * Add `asset` (a workout) as an overlay at timeline `atSec` and select it.
 * `sync` looks for footage there to line up with; resolves with whether it did.
 */
export async function placeWorkout(asset: MediaAsset, atSec: number, sync: boolean): Promise<{ synced: boolean }> {
  const summary = asset.probe.workout
  const rideSec = asset.probe.durationSec
  if (!summary || !(rideSec > 0)) return { synced: false }
  const widgets = defaultWidgets(summary.channels, newId)
  const id = newId()

  const before = sync ? syncCandidate(getActiveComp()?.layers ?? [], atSec) : null
  const recorded = before ? await recordedAt(before.content.mediaId) : null
  // The recording-time read is async: let a drag in progress finish first,
  // then sync to the clip as it is NOW (it may have moved or been trimmed).
  await idle()
  const now = before && getActiveComp()?.layers.find((l) => l.id === before.id)
  const clip = now ? syncCandidate([now], now.startSec) : null
  const window =
    clip && recorded && clip.content.mediaId === before?.content.mediaId
      ? syncedWindow(summary.startUtc, rideSec, {
          startSec: clip.startSec,
          endSec: clip.endSec,
          shownFromUtcMs: Date.parse(recorded) + clip.content.inSec * 1000
        })
      : null

  const layer = window
    ? makeWorkoutLayer(id, asset.id, window.startSec, { inSec: window.inSec, outSec: window.outSec, speed: 1 }, widgets)
    : makeWorkoutLayer(id, asset.id, atSec, { inSec: 0, outSec: rideSec, speed: rideSec / WHOLE_WORKOUT_SEC }, widgets)
  useProject.getState().addWorkoutLayer(layer, window && clip ? clip.id : undefined)
  useUi.getState().selectTile(getActiveComp(), { kind: 'layer', id })
  return { synced: !!window }
}
