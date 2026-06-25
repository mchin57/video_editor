/**
 * Pure, dependency-free helpers for the unified layer stack. Shared by the
 * preview (renderer) and the exporter (main) so placement/timing/stacking math
 * is computed identically on both sides. Coordinates are logical 1080x1920 px.
 */

import type { Layer, LayerContent, PillStyle, VideoContent } from './project'

export const FRAME = { width: 1080, height: 1920 } as const
export const HOOK_WINDOW_SEC = 3

/** Layers on screen at timeline time `t`, in stack order (back → front). */
export function layersAtTime(layers: Layer[], t: number): Layer[] {
  return layers.filter((l) => t >= l.startSec && t < l.endSec)
}

/** Overall end of the visual stack (seconds). */
export function visualDuration(layers: Layer[]): number {
  return layers.reduce((max, l) => Math.max(max, l.endSec), 0)
}

/** Total extra played time a video layer's freeze holds add (seconds). */
export function freezeExtraSec(content: VideoContent): number {
  return (content.freezes ?? []).reduce((sum, f) => sum + Math.max(0, f.holdSec), 0)
}

/**
 * Source-media time a video layer should show at timeline time `t`, honoring any
 * freeze holds. Played time runs `inSec → outSec` but pauses on each freeze's
 * source frame for its `holdSec`, so the played window is longer than the source
 * span by `freezeExtraSec`.
 */
export function videoSourceTime(content: VideoContent, layer: Layer, t: number): number {
  let local = t - layer.startSec // played time within the (stretched) layer
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  for (const f of freezes) {
    // Earlier holds are already removed from `local`, so this freeze sits at its
    // raw source distance from the in-point in the reduced timeline.
    const atPlayed = f.atSec - content.inSec
    if (local < atPlayed) break // freeze is still ahead — normal linear mapping
    if (local < atPlayed + f.holdSec) return clampSrc(content, f.atSec) // inside the hold
    local -= Math.max(0, f.holdSec) // passed it: drop its hold as dead played time
  }
  return clampSrc(content, content.inSec + local)
}

function clampSrc(content: VideoContent, s: number): number {
  return Math.min(content.outSec, Math.max(content.inSec, s))
}

/** True if timeline time `t` falls inside one of the layer's freeze holds. */
export function isFrozenAt(content: VideoContent, layer: Layer, t: number): boolean {
  let local = t - layer.startSec
  const freezes = [...(content.freezes ?? [])].sort((a, b) => a.atSec - b.atSec)
  for (const f of freezes) {
    const atPlayed = f.atSec - content.inSec
    if (local < atPlayed) return false
    if (local < atPlayed + f.holdSec) return true
    local -= Math.max(0, f.holdSec)
  }
  return false
}

/** The background is the bottom-most (index 0) layer. */
export function isBackgroundId(layers: Layer[], id: string): boolean {
  return layers.length > 0 && layers[0].id === id
}

/** Index a brand-new layer should be inserted at: the front (top of the stack). */
export function frontIndex(layers: Layer[]): number {
  return layers.length
}

/** A human label for a layer (custom name, else derived from its content). */
export function layerLabel(layer: Layer): string {
  if (layer.name && layer.name.trim()) return layer.name.trim()
  const c = layer.content
  if (c.kind === 'text') return c.text.trim() || 'Text'
  if (c.kind === 'image') return 'Image'
  return 'Video'
}

/**
 * Reapply a new front-to-back order of the *visible* layers onto the full stack,
 * leaving layers that aren't visible at the current time pinned to their slots.
 * `visibleBackToFront` are the visible layer ids in their new back→front order.
 */
export function applyVisibleOrder(layers: Layer[], visibleBackToFront: string[]): Layer[] {
  const byId = new Map(layers.map((l) => [l.id, l]))
  const ordered = visibleBackToFront
    .map((id) => byId.get(id))
    .filter((l): l is Layer => l != null)
  const visibleSet = new Set(visibleBackToFront)
  let vi = 0
  return layers.map((l) => (visibleSet.has(l.id) ? ordered[vi++] ?? l : l))
}

/** Move the layer at `from` to index `to`, returning a new array. */
export function moveLayer(layers: Layer[], from: number, to: number): Layer[] {
  if (from === to || from < 0 || from >= layers.length || to < 0 || to >= layers.length) return layers
  const next = layers.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** True if some non-empty text layer is on screen during the first 3 seconds. */
export function hookCovered(layers: Layer[]): boolean {
  return layers.some(
    (l) =>
      l.content.kind === 'text' &&
      l.content.text.trim().length > 0 &&
      l.startSec < HOOK_WINDOW_SEC &&
      l.endSec > 0
  )
}

// --- Factories --------------------------------------------------------------

const DEFAULT_PILL: PillStyle = { enabled: true, color: '#000000cc', padPx: 18 }

/** A full-frame video layer placed at `startSec` for `durationSec`. */
export function makeVideoLayer(
  id: string,
  mediaId: string,
  startSec: number,
  durationSec: number,
  opts: { mute?: boolean } = {}
): Layer {
  const dur = Math.max(0.1, durationSec)
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(0, startSec) + dur,
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: 1,
    content: { kind: 'video', mediaId, inSec: 0, outSec: dur, mute: opts.mute ?? false, gainDb: 0, crop: null }
  }
}

/** A centered image layer (~half the frame), for the given time window. */
export function makeImageLayer(id: string, mediaId: string, startSec: number, endSec: number): Layer {
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: 0.5,
    content: { kind: 'image', mediaId, opacity: 1 }
  }
}

/** A default text layer placed at the given time window. */
export function makeTextLayer(id: string, startSec: number, endSec: number): Layer {
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: FRAME.width / 2,
    y: FRAME.height * 0.32,
    scale: 1,
    content: {
      kind: 'text',
      text: 'Your hook here',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSizePx: 76,
      color: '#ffffff',
      pill: { ...DEFAULT_PILL }
    }
  }
}

/** Narrow a layer's content to a kind (handy in TS-land render switches). */
export function contentOfKind<K extends LayerContent['kind']>(
  content: LayerContent,
  kind: K
): Extract<LayerContent, { kind: K }> | null {
  return content.kind === kind ? (content as Extract<LayerContent, { kind: K }>) : null
}
