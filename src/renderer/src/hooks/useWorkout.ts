/**
 * A workout's decoded recording in the renderer (`WorkoutSeries`, read from
 * main once per media item + project folder and cached), for its overlay and
 * Inspector.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { WorkoutSeries } from '@shared/workout'
import { createLogger } from '@shared/log'
import { getWorkout } from '@/ipc/client'
import { useProject } from '@/state/projectStore'

export const WORKOUT_KEY = 'workout'

const log = createLogger('workout')

/** The recording (undefined while loading, or when it can't be read). */
export function useWorkoutSeries(mediaId: string | undefined): WorkoutSeries | undefined {
  // The folder is part of the key: another project's cache is another file.
  const filePath = useProject((s) => s.filePath)
  const q = useQuery({
    queryKey: [WORKOUT_KEY, filePath, mediaId],
    queryFn: () =>
      getWorkout(mediaId!).catch((error: unknown) => {
        // The overlay draws nothing without it: say why in the log.
        log.warn(`reading the workout ${mediaId} failed`, error)
        throw error
      }),
    enabled: !!mediaId,
    staleTime: Infinity,
    retry: false
  })
  return q.data
}

/** Drop the cached recording for a media item (after a Relink points it at
 *  another file) so the next read decodes the new one. */
export const invalidateWorkout = (qc: QueryClient, mediaId: string): Promise<void> =>
  qc.invalidateQueries({ queryKey: [WORKOUT_KEY], predicate: (q) => q.queryKey[2] === mediaId })
