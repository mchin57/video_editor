/**
 * Transitions in the export (#64). The opacity ramps ride the keyframed-opacity
 * path (`CompositionRender.opacityAnim` samples `layerOpacityPoints`); what is
 * here is the DIP PLATE: a full-frame colour painted onto the running composite
 * directly under the layer it belongs beneath, for the transition window — the
 * export twin of the preview's `dipPlatesUnder`. Both come from
 * `transitionPlates` (shared/transitions.ts). Verified against the real binary
 * (docs/FFMPEG-NOTES.md "Transitions"): a `drawbox` filling the frame gives a
 * clean dip, and needs `replace=1` to show on a transparent nested-comp base.
 */

import type { Layer } from '@shared/project'
import { transitionPlates, type TransitionPlate } from '@shared/transitions'
import { f3 } from './ffmpegFilters'
import type { ExportPlate, ExportVisual } from './exporterArgs'

/** `#rrggbb` → ffmpeg's `0xRRGGBB`. */
const ffColor = (c: string): string => `0x${c.replace(/^#/, '').slice(0, 6).toUpperCase()}`

/** The filter that paints a plate over the whole composite (`[prev]…[out]`). */
export function plateFilter(p: ExportPlate): string {
  return `drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(p.color)}:t=fill:replace=1:enable='between(t,${f3(p.startSec)},${f3(p.endSec)})'`
}

/** A composition's dip plates, keyed by the layer each goes under. Empty for a
 *  stack without dips, so such an export gains no step. */
export function platesByLayer(layers: Layer[]): Map<string, ExportVisual[]> {
  const out = new Map<string, ExportVisual[]>()
  for (const p of transitionPlates(layers)) out.set(p.belowId, [...(out.get(p.belowId) ?? []), plateVisual(p)])
  return out
}

const plateVisual = (p: TransitionPlate): ExportVisual => ({
  kind: 'plate',
  plate: { color: p.color, startSec: p.startSec, endSec: p.endSec }
})
