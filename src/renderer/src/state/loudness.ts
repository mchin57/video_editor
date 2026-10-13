/**
 * The renderer's cache of loudness series (shared/loudness.ts), fetched per
 * media id through the `getLoudness` IPC — which waits for (or starts) main's
 * measurement. Only clips in a volume level need one, so nothing is fetched for
 * a project that uses none.
 *
 * `seriesOf(id)` is the `GainContext.seriesOf` the preview hands `clipGain`:
 * `undefined` while the request is out ("measuring"), `null` when there is no
 * series (no audio, measurement failed).
 *
 * The cache belongs to the OPEN project: it is cleared when another document
 * is opened or created (a media id there may name another file, and its
 * failures say nothing here), and answers still in flight for the old one are
 * dropped. A `null` is never final: asking again re-fetches it (main answers a
 * remembered failure at once, without re-running ffmpeg), as does a library
 * change — otherwise the preview could keep "couldn't measure" while the
 * export, which asks main afresh, levels the clip.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import type { LoudnessSeries } from '@shared/loudness'
import { getLoudness } from '@/ipc/client'
import { useProject } from '@/state/projectStore'

interface LoudnessState {
  series: Record<string, LoudnessSeries | null>
  /** Bumped by `reset`: an answer for an older generation is for another
   *  project, and requesters ask again for the new one. */
  generation: number
  /** Fetch `mediaId`'s series unless it is cached (a cached null is fetched
   *  again) or already on its way. */
  request: (mediaId: string) => void
  /** Re-fetch every cached series (the library changed: a relink or a fixed
   *  path can change what a clip measures, and a failed one may succeed now).
   *  The old value stays in force until the new one lands, so levelled clips
   *  don't drop to "measuring" mid-playback. */
  refresh: () => void
  /** Forget everything (another project was opened). */
  reset: () => void
}

const pending = new Set<string>()

export const useLoudness = create<LoudnessState>((set, get) => {
  const fetch = (mediaId: string): void => {
    pending.add(mediaId)
    const asked = get().generation
    const done = (s: LoudnessSeries | null): void => {
      if (asked !== get().generation) return
      pending.delete(mediaId)
      const { series } = get()
      if (!(mediaId in series) || series[mediaId] !== s) set({ series: { ...series, [mediaId]: s } })
    }
    getLoudness(mediaId).then(done, () => done(null))
  }
  return {
    series: {},
    generation: 0,
    request: (mediaId) => {
      if (pending.has(mediaId)) return
      const cached = get().series[mediaId]
      if (cached !== undefined && cached !== null) return
      fetch(mediaId)
    },
    refresh: () => {
      for (const mediaId of Object.keys(get().series)) if (!pending.has(mediaId)) fetch(mediaId)
    },
    reset: () => {
      pending.clear()
      set({ series: {}, generation: get().generation + 1 })
    }
  }
})

// Another document opened or created (Open, New, launch): its own cache.
useProject.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id || s.filePath !== prev.filePath) useLoudness.getState().reset()
})

/** Make sure each of `mediaIds` is fetched (call from a component). */
export function useRequestLoudness(mediaIds: readonly (string | null)[]): void {
  const key = mediaIds.filter(Boolean).join('|')
  const generation = useLoudness((s) => s.generation) // after a reset, ask again
  useEffect(() => {
    if (!key) return
    const { request } = useLoudness.getState()
    for (const id of key.split('|')) request(id)
  }, [key, generation])
}
