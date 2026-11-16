/** Preview ▸ transitions: the full-frame colour plate a dip shows while neither
 *  picture does (`transitionPlates`, shared/transitions.ts — the export paints
 *  the same plates as a `drawbox`). The layers' opacity ramps themselves are in
 *  each layer box (`layerOpacityAt`, preview/layers.tsx). */

import type { JSX } from 'react'
import type { FrameRect } from '@shared/layers'
import { platesUnderAt, type TransitionPlate } from '@shared/transitions'
import { LOGICAL } from '@/lib/coords'
import { pct } from './frame'

/**
 * The plates on screen at `time` directly under layer `layerId`, as elements to
 * render just BEFORE that layer's own, at the same `z` (equal z-index: the
 * later sibling paints on top, so the plate sits under the layer and over
 * everything below it). Each covers the project's output frame.
 */
export function dipPlatesUnder(
  plates: TransitionPlate[],
  layerId: string,
  time: number,
  z: number,
  frame: FrameRect
): JSX.Element[] {
  return platesUnderAt(plates, layerId, time).map((p, i) => (
    <div
      key={`plate-${layerId}-${i}`}
      data-testid="dip-plate"
      className="pointer-events-none"
      style={{
        position: 'absolute',
        left: pct(frame.x, LOGICAL.width),
        top: pct(frame.y, LOGICAL.height),
        width: pct(frame.w, LOGICAL.width),
        height: pct(frame.h, LOGICAL.height),
        background: p.color,
        zIndex: z
      }}
    />
  ))
}
