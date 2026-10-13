/**
 * The renderer's cache of loudness series (shared/loudness.ts), fetched once per
 * media id through the `getLoudness` IPC — which waits for (or starts) main's
 * measurement. Only clips in a volume level need one, so nothing is fetched for
 * a project that uses none.
 *
 * `seriesOf(id)` is the `GainContext.seriesOf` the preview hands `clipGain`:
 * `undefined` while the request is out ("measuring"), `null` when there is no
 * series (no audio, measurement failed).
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import type { LoudnessSeries } from '@shared/loudness'
import { getLoudness } from '@/ipc/client'

interface LoudnessState {
  series: Record<string, LoudnessSeries | null>
  /** Fetch `mediaId`'s series unless it is cached or already on its way. */
  request: (mediaId: string) => void
  /** Re-fetch every cached series (the library changed: a relink or a fixed
   *  path can change what a clip measures, and a failed one may succeed now).
   *  The old value stays in force until the new one lands, so levelled clips
   *  don't drop to "measuring" mid-playback. */
  refresh: () => void
}

const pending = new Set<string>()

export const useLoudness = create<LoudnessState>((set, get) => ({
  series: {},
  request: (mediaId) => {
    if (mediaId in get().series || pending.has(mediaId)) return
    pending.add(mediaId)
    const done = (s: LoudnessSeries | null): void => {
      pending.delete(mediaId)
      set({ series: { ...get().series, [mediaId]: s } })
    }
    getLoudness(mediaId).then(done, () => done(null))
  },
  refresh: () => {
    for (const mediaId of Object.keys(get().series)) {
      if (pending.has(mediaId)) continue
      pending.add(mediaId)
      const done = (s: LoudnessSeries | null): void => {
        pending.delete(mediaId)
        if (get().series[mediaId] !== s) set({ series: { ...get().series, [mediaId]: s } })
      }
      getLoudness(mediaId).then(done, () => done(null))
    }
  }
}))

/** Make sure each of `mediaIds` is fetched (call from a component). */
export function useRequestLoudness(mediaIds: readonly (string | null)[]): void {
  const key = mediaIds.filter(Boolean).join('|')
  useEffect(() => {
    if (!key) return
    const { request } = useLoudness.getState()
    for (const id of key.split('|')) request(id)
  }, [key])
}
