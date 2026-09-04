/**
 * Gain for the preview's media elements.
 *
 * Applies a clip's `gainDb` to its `<audio>`/`<video>` follower, mirroring the
 * export's `volume=` filter. `dbToGain` is the same conversion the export uses
 * (`main/services/audio.ts`) — keep the two in step.
 *
 * **Above 0 dB the preview does not match the export — currently by choice, no
 * longer by necessity.** `HTMLMediaElement.volume` is spec-clamped to [0, 1],
 * so a boost needs WebAudio, and WebAudio needs a CORS-clean element.
 *
 * That used to be impossible. `reelmedia://` was registered WITHOUT the
 * `corsEnabled` privilege, so `crossOrigin="anonymous"` made media fail to load
 * outright (`MEDIA_ELEMENT_ERROR: Format error`) no matter what
 * `Access-Control-Allow-Origin` the handler returned, and dropping
 * `crossOrigin` left the element tainted — `createMediaElementSource` did not
 * throw, but an AnalyserNode on it measured a peak amplitude of exactly 0.
 *
 * Fixing the font-loading bug removed that wall: the scheme is now `corsEnabled`
 * and answers with `Access-Control-Allow-Origin` (`main/mediaProtocol.ts`).
 * Re-measured against the real app afterwards, from the production `file://`
 * page: a `crossOrigin="anonymous"` element reaches `canplay`, and an
 * AnalyserNode on the resulting graph reads a peak of ~0.26 — real signal, not
 * silence. So a GainNode here WOULD work now.
 *
 * It is deliberately not wired up yet: routing every preview element through an
 * AudioContext is a behaviour change to all preview audio, not a free win, and
 * a boost above unity is the rarer half of the feature. Until someone takes
 * that on, a boost stays capped at unity in the preview and correct in the
 * export (`e2e/previewGain.spec.ts` pins both halves).
 *
 * Below 0 dB — the common case, and the only one that affects a mix decision
 * you can act on — `element.volume` IS exact: it is a plain linear gain, the
 * same thing `volume=` applies.
 */

import { useEffect } from 'react'

/** dB → linear gain. The same conversion the export applies in `dbToGain`
 *  (`main/services/audio.ts`); the two must stay in step. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * Apply `gainDb` to a preview media element. `muted` forces silence.
 *
 * Gains above 0 dB clamp to unity — see the module header for why that cannot
 * be fixed from here. Everything at or below 0 dB is exact.
 */
export function useMediaGain(
  ref: { current: HTMLMediaElement | null },
  gainDb: number,
  muted = false
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const linear = muted ? 0 : dbToGain(gainDb)
    el.volume = Math.min(1, Math.max(0, linear))
  }, [ref, gainDb, muted])
}
