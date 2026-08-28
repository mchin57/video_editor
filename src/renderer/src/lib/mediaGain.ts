/**
 * Gain for the preview's media elements.
 *
 * Applies a clip's `gainDb` to its `<audio>`/`<video>` follower, mirroring the
 * export's `volume=` filter. `dbToGain` is the same conversion the export uses
 * (`main/services/audio.ts`) — keep the two in step.
 *
 * **Above 0 dB the preview cannot match the export, and this is a dead end, not
 * an oversight.** `HTMLMediaElement.volume` is spec-clamped to [0, 1], so a
 * boost needs WebAudio — and WebAudio cannot be reached from here. Both routes
 * were tried against the real app and both fail (see `e2e/previewGain.spec.ts`,
 * which pins the working half):
 *
 * - Media is served from `reelmedia://`, a different origin from the renderer
 *   page, so `createMediaElementSource` needs a CORS-clean element. Adding
 *   `crossOrigin="anonymous"` makes the media **fail to load outright**
 *   (`MEDIA_ELEMENT_ERROR: Format error`): the production page is `file://`,
 *   whose origin serialises to `null`, and Chromium refuses the CORS request
 *   whatever `Access-Control-Allow-Origin` the protocol handler returns.
 * - Without `crossOrigin` the media loads and plays, and
 *   `createMediaElementSource` does NOT throw — but the element is tainted, so
 *   the graph emits SILENCE. Measured: an AnalyserNode on a playing element
 *   (`readyState` 4, `currentTime` advancing, context running) read a peak
 *   amplitude of exactly 0.
 *
 * So routing through WebAudio would either break preview audio entirely or mute
 * it. The real prerequisite is giving the renderer a true origin (serving it
 * from a custom standard scheme instead of `file://`), at which point the first
 * route starts working and this module can grow a GainNode. Until then a boost
 * is capped at unity in the preview and correct in the export.
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
