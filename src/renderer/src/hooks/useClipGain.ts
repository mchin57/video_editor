import type { AudioClip } from '@shared/project'
import { clipGain, seriesNeeded, type ClipGain } from '@shared/volumeLevels'
import type { VolumeLevel } from '@shared/project'
import { useProject } from '@/state/projectStore'
import { useLoudness, useRequestLoudness } from '@/state/loudness'

const NO_LEVELS: VolumeLevel[] = []

/**
 * A clip's effective gain in the renderer — `clipGain` (shared/volumeLevels.ts,
 * the export's own call) fed the project's levels and the cached loudness
 * series, fetching the one series it needs. `clips` is the clip's own
 * composition (an effect track finds its source there); `durationOf` resolves
 * a source's length (0 = unknown).
 */
export function useClipGain(
  clip: AudioClip,
  clips: readonly AudioClip[],
  durationOf: (mediaId: string) => number
): ClipGain {
  const levels = useProject((s) => s.project?.volumeLevels ?? NO_LEVELS)
  const need = seriesNeeded(clip, clips, levels)
  useRequestLoudness([need])
  // Subscribed so the gain updates the moment the series arrives.
  useLoudness((s) => (need ? s.series[need] : undefined))
  return clipGain(clip, clips, {
    levels,
    seriesOf: (id) => useLoudness.getState().series[id],
    durationOf
  })
}
