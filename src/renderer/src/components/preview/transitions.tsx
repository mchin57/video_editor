/** Preview ▸ transitions: the colour CARD a dip shows while neither picture
 *  does — behind the dipping clips' boxes only (`transitionPlates`,
 *  shared/transitions.ts; the export places the same card with each clip's own
 *  placement steps). The layers' opacity ramps themselves are in each layer box
 *  (`layerOpacityAt`, preview/layers.tsx). */

import type { JSX } from 'react'
import type { Layer } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { platesUnderAt, type TransitionPlate } from '@shared/transitions'
import { mediaBox, mediaLayerAspect, withKeyframedTransform } from './geometry'

/**
 * The cards on screen at `time` directly under layer `layerId`, as elements to
 * render just BEFORE that layer's own, at the same `z` (equal z-index: the
 * later sibling paints on top, so the card sits under the layer and over
 * everything below it). Each card is the union of its covered tiles' boxes:
 * one box per tile, drawn with the tile's own `mediaBox` at its keyframed
 * transform at `time` — exactly where the tile's picture is.
 */
export function dipPlatesUnder(
  plates: TransitionPlate[],
  layers: Layer[],
  layerId: string,
  time: number,
  z: number,
  assetById: Map<string, MediaAsset>
): JSX.Element[] {
  return platesUnderAt(plates, layerId, time).map((p, i) => (
    <div
      key={`plate-${layerId}-${i}`}
      data-testid="dip-plate"
      data-color={p.color}
      className="pointer-events-none"
      style={{ position: 'absolute', inset: 0, zIndex: z }}
    >
      {p.coverIds.map((id) => {
        const l = layers.find((x) => x.id === id)
        if (!l || (l.content.kind !== 'video' && l.content.kind !== 'image')) return null
        const asset = assetById.get(l.content.mediaId)
        return (
          <div
            key={id}
            data-testid="dip-plate-box"
            data-cover={id}
            style={{ ...mediaBox(withKeyframedTransform(l, time), mediaLayerAspect(l, asset)), background: p.color }}
          />
        )
      })}
    </div>
  ))
}
