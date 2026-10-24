/**
 * Pose data in the renderer: whether detection can run (the models are
 * installed), and a media item's detected keypoints (`PoseData`, read from the
 * project folder once and cached — `invalidatePose` after a detection).
 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { PoseAvailability } from '@shared/ipc'
import type { PoseData } from '@shared/pose'
import { getPose, poseAvailable } from '@/ipc/client'
import { useProject } from '@/state/projectStore'

export const POSE_KEY = 'pose'

/** A media item's detection (null = not detected yet; undefined = loading or no id). */
export function usePoseData(mediaId: string | undefined, enabled = true): PoseData | null | undefined {
  // The folder is part of the key: another project's `pose/` is another file.
  const filePath = useProject((s) => s.filePath)
  const q = useQuery({
    queryKey: [POSE_KEY, filePath, mediaId],
    queryFn: () => getPose(mediaId!),
    enabled: enabled && !!mediaId,
    staleTime: Infinity
  })
  return q.data
}

/** Whether pose detection can run here (re-checked on window focus, so
 *  installing the models while the app is open is picked up). */
export function usePoseAvailable(): PoseAvailability | undefined {
  return useQuery({ queryKey: ['poseAvailable'], queryFn: () => poseAvailable(), refetchOnWindowFocus: true }).data
}

/** Drop the cached detection(s) for a media item so the next read refetches. */
export const invalidatePose = (qc: QueryClient, mediaId: string): Promise<void> =>
  qc.invalidateQueries({ queryKey: [POSE_KEY], predicate: (q) => q.queryKey[2] === mediaId })
