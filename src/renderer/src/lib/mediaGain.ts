/**
 * Gain for the preview's media elements, matching the export's `volume=` filter.
 *
 * `HTMLMediaElement.volume` CLAMPS AT 1.0, so a clip with `gainDb > 0` played at
 * unity in the preview while the export boosted it (`volume=` has no ceiling) —
 * and a video layer's `gainDb` was not applied to the preview at all. Both are
 * fixed here by routing the element through a WebAudio `GainNode`, whose gain is
 * unbounded, so preview and export agree at any dB.
 *
 * Routing is LAZY: at or below 0 dB the element's own `volume` is exact (it is a
 * plain linear gain, same as the filter), so the WebAudio path is only entered
 * once a clip actually asks for a boost. That keeps the common case on the
 * long-standing code path — see the CORS note below for why that matters.
 *
 * **CORS.** Media is served from `reelmedia://`, a DIFFERENT origin from the
 * renderer page. `createMediaElementSource` on a cross-origin element that is
 * not CORS-clean produces SILENCE (it does not throw), so this needs BOTH
 * `crossOrigin="anonymous"` on the element (`MEDIA_CROSS_ORIGIN`) and the
 * `Access-Control-Allow-Origin` header the protocol handler sends
 * (`main/mediaProtocol.ts`). Remove either and boosted clips go silent.
 *
 * An element can be routed only ONCE — `createMediaElementSource` throws on a
 * second call for the same element — so nodes are cached per element in a
 * WeakMap and reused across re-mounts. Once routed, an element STAYS routed
 * (its audio now flows through the graph), so the gain node keeps driving it
 * even if the clip later drops back below 0 dB.
 */

import { useEffect } from 'react'

/** `crossOrigin` for every preview media element. Required for the WebAudio
 *  path; harmless on the plain `volume` path. @see the CORS note above. */
export const MEDIA_CROSS_ORIGIN = 'anonymous'

/** dB → linear gain. The same conversion the export applies in `dbToGain`
 *  (`main/services/audio.ts`); the two must stay in step. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

let sharedCtx: AudioContext | null = null
let ctxUnavailable = false

function audioContext(): AudioContext | null {
  if (sharedCtx || ctxUnavailable) return sharedCtx
  try {
    sharedCtx = new AudioContext()
  } catch {
    ctxUnavailable = true
  }
  return sharedCtx
}

const routed = new WeakMap<HTMLMediaElement, GainNode>()

/** Route an element through a GainNode (once), returning it. Null when WebAudio
 *  is unavailable — the caller then falls back to `element.volume`. */
function routeThroughGain(el: HTMLMediaElement): GainNode | null {
  const existing = routed.get(el)
  if (existing) return existing
  const ctx = audioContext()
  if (!ctx) return null
  try {
    const gain = ctx.createGain()
    ctx.createMediaElementSource(el).connect(gain)
    gain.connect(ctx.destination)
    routed.set(el, gain)
    return gain
  } catch {
    return null
  }
}

/** Resume the shared context — it can start suspended until a user gesture. */
export function resumePreviewAudio(): void {
  const ctx = sharedCtx
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
}

/**
 * Apply `gainDb` to a preview media element. `muted` forces silence through the
 * same path, so muting does not depend on how the element's `muted` attribute
 * interacts with a WebAudio graph.
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
    // Enter the WebAudio path only for a boost — but keep using it forever once
    // this element has been routed, since its audio no longer reaches the
    // speakers any other way.
    const gain = linear > 1 || routed.has(el) ? routeThroughGain(el) : null
    if (gain) {
      el.volume = 1
      gain.gain.value = linear
      resumePreviewAudio()
    } else {
      el.volume = Math.min(1, Math.max(0, linear))
    }
  }, [ref, gainDb, muted])
}
