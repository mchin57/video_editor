/**
 * Transitions in the export (#64). The opacity ramps ride the keyframed-opacity
 * path (`CompositionRender.opacityAnim` samples `layerOpacityPoints`); what is
 * here is the DIP CARD: a solid colour behind the dipping clips, painted onto
 * the running composite directly under the layer it belongs beneath, over the
 * half-open window [start, end) — the export twin of the preview's
 * `dipPlatesUnder`. Both come from `transitionPlates` (shared/transitions.ts):
 * the card is the UNION of the boxes of its `coverIds` (the pair's two clips,
 * or a lone side's own clip), so a picture-in-picture dip blanks only the PiP
 * and a letterboxed clip's bars keep what lies under them.
 *
 * Each box is placed exactly as its clip's own picture is: `boxOf` is the
 * clip exporter's own geometry (`mediaLayerBox`, exportLayers.ts) and the
 * chain goes through the same placement steps as the clip (`plateChains` in
 * exporterArgs.ts) — size, stretch, crop, rotation and keyframes. Verified
 * against the real binary (docs/FFMPEG-NOTES.md "Transitions").
 */

import type { Layer } from '@shared/project'
import { transitionPlates } from '@shared/transitions'
import type { ExportBox, ExportVisual } from './exporterArgs'

/**
 * A composition's dip cards as compositor steps, keyed by the layer each goes
 * under: one `plate` visual per box of the card, i.e. per covered clip whose
 * box `boxOf` resolves. Empty for a stack without dips, so such an export
 * gains no step.
 */
export async function platesByLayer(
  layers: Layer[],
  boxOf: (l: Layer) => Promise<ExportBox | null>
): Promise<Map<string, ExportVisual[]>> {
  const out = new Map<string, ExportVisual[]>()
  for (const p of transitionPlates(layers)) {
    for (const id of p.coverIds) {
      const l = layers.find((x) => x.id === id)
      const box = l ? await boxOf(l) : null
      if (!box) continue
      const visual: ExportVisual = {
        kind: 'plate',
        plate: { color: p.color, startSec: p.startSec, endSec: p.endSec, box }
      }
      out.set(p.belowId, [...(out.get(p.belowId) ?? []), visual])
    }
  }
  return out
}
