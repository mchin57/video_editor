/**
 * Pure helpers for text overlays + the Instagram "hook in the first 3 seconds"
 * rule. Overlay coordinates are in the logical 1080x1920 space.
 */

import type { ImageOverlay, TextOverlay } from '@shared/project'
import { LOGICAL } from './coords'

export const HOOK_WINDOW_SEC = 3

/** Overlays visible at timeline time `t`. */
export function overlaysAtTime(overlays: TextOverlay[], t: number): TextOverlay[] {
  return overlays.filter((o) => t >= o.startSec && t < o.endSec)
}

/** Image overlays visible at timeline time `t`. */
export function imageOverlaysAtTime(overlays: ImageOverlay[], t: number): ImageOverlay[] {
  return overlays.filter((o) => t >= o.startSec && t < o.endSec)
}

/**
 * A default image overlay: centered, ~45% of the canvas width, height from the
 * source aspect, placed at the given time window.
 */
export function makeImageOverlay(
  id: string,
  mediaId: string,
  startSec: number,
  endSec: number,
  aspect: number // source width / height
): ImageOverlay {
  const w = Math.round(LOGICAL.width * 0.45)
  const h = Math.round(w / (aspect > 0 ? aspect : 1))
  return {
    id,
    mediaId,
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: LOGICAL.width / 2,
    y: LOGICAL.height / 2,
    w,
    h,
    anchor: 'center',
    opacity: 1
  }
}

/** True if some non-empty text overlay is on screen during the first 3 seconds. */
export function hookCovered(overlays: TextOverlay[]): boolean {
  return overlays.some(
    (o) => o.text.trim().length > 0 && o.startSec < HOOK_WINDOW_SEC && o.endSec > 0
  )
}

/** A sensible default overlay placed at the given time window. */
export function makeOverlay(id: string, startSec: number, endSec: number): TextOverlay {
  return {
    id,
    text: 'Your hook here',
    startSec: Math.max(0, startSec),
    endSec: Math.max(startSec + 0.5, endSec),
    x: LOGICAL.width / 2,
    y: LOGICAL.height * 0.32,
    anchor: 'center',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSizePx: 76,
    color: '#ffffff',
    pill: { enabled: true, color: '#000000cc', padPx: 18 }
  }
}
