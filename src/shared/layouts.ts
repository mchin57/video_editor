/**
 * Multi-clip layouts (split screen / panels): the built-in cell arrangements
 * and the pure geometry shared by the preview and the exporter.
 *
 * A layout preset is N cell rects authored in the LOGICAL 1080×1920 space and
 * stretched onto whatever output frame the project uses (`layoutCellRect`), so
 * every arrangement fills every aspect ratio. A cell shows
 * its clip aspect-FILL (center cover-crop): the preview uses
 * `object-fit: cover`, the export crops the source with `coverCrop` — the two
 * must stay in agreement, so both resolve their geometry here. The layout
 * layer's own x/y/scale move/zoom the whole arrangement via `layoutCellRect`
 * (identity at the default center/scale-1 transform).
 */

import { FRAME, FULL_FRAME, type FrameRect } from './frame'
import type { CellRect, Layer, LayoutCell, LayoutContent } from './project'

export interface LayoutPreset {
  id: string
  label: string
  /** Cell rects in logical 1080×1920 px, back → front. */
  rects: CellRect[]
}

const W = FRAME.width
const H = FRAME.height

/** The built-in layout presets (docs/TODO.md "Multi-clip layout formats"). */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'split-lr',
    label: 'Split L|R',
    rects: [
      { x: 0, y: 0, w: W / 2, h: H },
      { x: W / 2, y: 0, w: W / 2, h: H }
    ]
  },
  {
    id: 'split-tb',
    label: 'Split T/B',
    rects: [
      { x: 0, y: 0, w: W, h: H / 2 },
      { x: 0, y: H / 2, w: W, h: H / 2 }
    ]
  },
  {
    id: 'cols-3',
    label: '3 columns',
    rects: [
      { x: 0, y: 0, w: W / 3, h: H },
      { x: W / 3, y: 0, w: W / 3, h: H },
      { x: (2 * W) / 3, y: 0, w: W / 3, h: H }
    ]
  },
  {
    id: 'rows-3',
    label: '3 rows',
    rects: [
      { x: 0, y: 0, w: W, h: H / 3 },
      { x: 0, y: H / 3, w: W, h: H / 3 },
      { x: 0, y: (2 * H) / 3, w: W, h: H / 3 }
    ]
  },
  {
    id: 'big-left',
    label: '1 big + 2',
    rects: [
      { x: 0, y: 0, w: (2 * W) / 3, h: H },
      { x: (2 * W) / 3, y: 0, w: W / 3, h: H / 2 },
      { x: (2 * W) / 3, y: H / 2, w: W / 3, h: H / 2 }
    ]
  },
  {
    id: 'big-right',
    label: '2 + 1 big',
    rects: [
      { x: 0, y: 0, w: W / 3, h: H / 2 },
      { x: 0, y: H / 2, w: W / 3, h: H / 2 },
      { x: W / 3, y: 0, w: (2 * W) / 3, h: H }
    ]
  },
  {
    id: 'grid-2x2',
    label: '2×2 grid',
    rects: [
      { x: 0, y: 0, w: W / 2, h: H / 2 },
      { x: W / 2, y: 0, w: W / 2, h: H / 2 },
      { x: 0, y: H / 2, w: W / 2, h: H / 2 },
      { x: W / 2, y: H / 2, w: W / 2, h: H / 2 }
    ]
  }
]

export function layoutPreset(id: string): LayoutPreset {
  return LAYOUT_PRESETS.find((p) => p.id === id) ?? LAYOUT_PRESETS[0]
}

/**
 * A cell's on-screen rect (canonical logical px) after the layout layer's
 * move/zoom. Cell rects are AUTHORED in the 1080×1920 space but mean "this
 * fraction of the output frame": the rect is first mapped onto `frame` (so a
 * layout always fills the project's aspect — Split L|R is two 960×1080 halves
 * in 16:9), then scaled about the frame center by `layer.scale` and translated
 * so that center lands on the layer's (x, y). Identity for the default
 * transform in the 9:16 frame. A compound clip's full-frame box resolves here
 * too (`FULL_CELL`).
 */
export function layoutCellRect(
  layer: Pick<Layer, 'x' | 'y' | 'scale'>,
  rect: CellRect,
  frame: FrameRect = FULL_FRAME
): CellRect {
  const s = layer.scale
  const fx = frame.w / W
  const fy = frame.h / H
  return {
    x: (frame.x + rect.x * fx - (frame.x + frame.w / 2)) * s + layer.x,
    y: (frame.y + rect.y * fy - (frame.y + frame.h / 2)) * s + layer.y,
    w: rect.w * fx * s,
    h: rect.h * fy * s
  }
}

/** The whole-frame cell: a compound clip's box / a layout's wrapper. */
export const FULL_CELL: CellRect = { x: 0, y: 0, w: W, h: H }

/**
 * Center cover-crop of a `srcW`×`srcH` source to `aspect` (w/h), in source
 * pixels — the export twin of the preview's `object-fit: cover`. A wide-of-cell
 * source crops its sides; a tall one crops top/bottom.
 */
export function coverCrop(srcW: number, srcH: number, aspect: number): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0 || aspect <= 0) return { x: 0, y: 0, w: Math.max(1, srcW), h: Math.max(1, srcH) }
  const srcAspect = srcW / srcH
  if (srcAspect > aspect) {
    const w = srcH * aspect
    return { x: (srcW - w) / 2, y: 0, w, h: srcH }
  }
  const h = srcW / aspect
  return { x: 0, y: (srcH - h) / 2, w: srcW, h }
}

/** Played span of a cell's clip (cells play at 1×; empty cells span 0). */
export function cellSpan(cell: LayoutCell): number {
  return cell.mediaId ? Math.max(0, cell.outSec - cell.inSec) : 0
}

/** A fresh layout layer at `startSec`: preset cells, empty (no media), muted. */
export function makeLayoutLayer(id: string, presetId: string, startSec: number, durationSec = 5): Layer {
  const preset = layoutPreset(presetId)
  const dur = Math.max(0.5, durationSec)
  return {
    id,
    hidden: false,
    startSec: Math.max(0, startSec),
    endSec: Math.max(0, startSec) + dur,
    x: W / 2,
    y: H / 2,
    scale: 1,
    content: {
      kind: 'layout',
      presetId: preset.id,
      cells: preset.rects.map((rect) => ({
        mediaId: null,
        inSec: 0,
        outSec: dur,
        mute: true,
        rect: { ...rect }
      }))
    }
  }
}

/**
 * Re-shape a layout to another preset, keeping each cell's media/trim/mute by
 * index (extra cells are dropped; new cells start empty).
 */
export function applyLayoutPreset(content: LayoutContent, presetId: string): LayoutContent {
  const preset = layoutPreset(presetId)
  const cells: LayoutCell[] = preset.rects.map((rect, i) => {
    const prev = content.cells[i]
    return prev ? { ...prev, rect: { ...rect } } : { mediaId: null, inSec: 0, outSec: 5, mute: true, rect: { ...rect } }
  })
  return { ...content, presetId: preset.id, cells }
}
