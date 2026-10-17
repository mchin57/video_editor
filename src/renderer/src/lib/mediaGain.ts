/**
 * Gain for the preview's media elements.
 *
 * Applies a clip's `gainDb` to its `<audio>`/`<video>` follower, mirroring the
 * export's `volume=` filter. `dbToGain` is the same conversion the export uses
 * (`main/services/audio.ts`) — keep the two in step.
 *
 * **Two routes, and which one an element takes is deliberate.**
 *
 * `HTMLMediaElement.volume` is spec-clamped to [0, 1], so it cannot express the
 * boost half of the range (the Inspector allows up to +6 dB). Above unity the
 * signal has to go through a WebAudio `GainNode`, which needs a CORS-clean
 * element — and that used to be impossible here: `reelmedia://` was registered
 * without the `corsEnabled` privilege, so `crossOrigin="anonymous"` made media
 * fail to load outright whatever `Access-Control-Allow-Origin` the handler
 * returned, and dropping `crossOrigin` left the element tainted (the graph
 * measured a peak of exactly 0 — silence). Fixing the font-loading bug removed
 * that wall; the scheme is now `corsEnabled` (`main/mediaProtocol.ts`).
 *
 * Re-measured against the real binary afterwards, for all three proxy kinds
 * (`audio.m4a`, `proxy.mp4`, the alpha `proxy.webm`): each reaches `canplay`
 * with `crossOrigin="anonymous"`, and a GainNode on it carries real signal —
 * +6 dB measured as exactly 2x the unity peak, and gain 0 as true silence.
 *
 * So: an element stays on plain `element.volume` until it actually needs more
 * than unity, and only then is it routed through the graph. That is not
 * timidity — `createMediaElementSource` can only ever be called ONCE per
 * element and cannot be undone, so routing everything would put every preview
 * sound permanently behind an AudioContext to buy something only the boost case
 * needs. Attenuation (the common case, and the only one that changes a mix
 * decision you can act on) keeps the simpler path it has always had. If routing
 * ever fails, the element falls back to the clamped `volume` for good rather
 * than going silent.
 *
 * `e2e/previewGain.spec.ts` pins both routes.
 */

import { useEffect } from 'react'

/** dB → linear gain. The same conversion the export applies in `dbToGain`
 *  (`main/services/audio.ts`); the two must stay in step. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** One shared context for the whole preview mix — built on the first boost, so
 *  a session that never boosts never creates one. */
let ctx: AudioContext | null = null

/**
 * Per-element graph tail. `GainNode` = routed; `null` = routing was tried and
 * failed, so never try again (the element keeps the `volume` path). A WeakMap
 * so unmounted elements are still collectable.
 */
const graphs = new WeakMap<HTMLMediaElement, GainNode | null>()

function resumeIfSuspended(): void {
  // A suspended context feeds a routed element into silence, so every path that
  // touches the graph nudges it back. `autoplayPolicy: 'no-user-gesture-required'`
  // (main/index.ts) means this is belt-and-braces, not the usual gesture dance.
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => {})
}

/**
 * Put `el` behind a GainNode, once. Returns the node, or `null` if this element
 * can't be routed — in which case the caller must fall back to `volume`.
 */
function routeThroughGain(el: HTMLMediaElement): GainNode | null {
  const existing = graphs.get(el)
  if (existing !== undefined) return existing
  try {
    ctx ??= new AudioContext()
    const gain = ctx.createGain()
    // Throws if this element was already routed; taints to silence if the
    // element is not CORS-clean — hence `crossOrigin` on the JSX, set before
    // `src` so the very first fetch is the CORS one.
    ctx.createMediaElementSource(el).connect(gain)
    gain.connect(ctx.destination)
    el.addEventListener('play', resumeIfSuspended)
    graphs.set(el, gain)
    resumeIfSuspended()
    return gain
  } catch {
    graphs.set(el, null)
    return null
  }
}

/**
 * The linear gain actually applied to `el` — read from the GainNode once the
 * element is routed, else its own clamped `volume`. Exposed for `e2e/` (via
 * `window.__reelStores`), which otherwise cannot tell a realised +6 dB from a
 * boost silently clamped to unity: both leave `element.volume` at 1.
 */
export function appliedGain(el: HTMLMediaElement): number {
  const gain = graphs.get(el)
  return gain ? gain.gain.value : el.volume
}

/** Whether `el` is running through the WebAudio graph rather than `volume`. */
export function isRouted(el: HTMLMediaElement): boolean {
  return !!graphs.get(el)
}

/**
 * State of the shared context, or `null` if nothing has needed one yet.
 * A routed element feeding a SUSPENDED context is silent while still reporting
 * a perfectly correct `appliedGain`, so `e2e/` asserts on this too.
 */
export function previewAudioState(): AudioContextState | null {
  return ctx?.state ?? null
}

/**
 * Apply `gainDb` to a preview media element. `muted` forces silence.
 *
 * At or below 0 dB this is a plain `element.volume` — exact, and the same
 * linear gain `volume=` applies. Above 0 dB the element is routed through a
 * GainNode so the boost is actually audible and matches the export.
 */
export function useMediaGain(ref: { current: HTMLMediaElement | null }, gainDb: number, muted = false): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const linear = muted ? 0 : dbToGain(gainDb)
    // Reach for the graph only when unity is not enough — but once an element
    // is routed it stays routed, since the routing cannot be undone.
    const gain = linear > 1 || graphs.get(el) ? routeThroughGain(el) : null
    if (gain) {
      // All of the level now lives in the node; the element runs wide open.
      el.volume = 1
      gain.gain.value = linear
      resumeIfSuspended()
    } else {
      el.volume = Math.min(1, Math.max(0, linear))
    }
  }, [ref, gainDb, muted])
}
