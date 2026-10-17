import type { JSX } from 'react'
import type { CellRect } from '@shared/project'
import { FRAME } from '@shared/layers'
import type { LayoutPreset } from '@shared/layouts'

/**
 * A scaled mini-frame that draws a layout preset's cells — the "what it will
 * look like" preview. The frame is rendered at `aspect` (the project's current
 * aspect ratio); the cell rects (authored in the 1080×1920 logical space) are
 * normalised to 0..1 fractions of that space and painted proportionally, so
 * Split L|R reads as a line down the middle at any aspect. Each cell is
 * numbered; a `thumb(i)` render-prop fills a cell with its assigned clip's
 * thumbnail when one exists.
 */
export function LayoutPresetPreview({
  preset,
  aspect,
  height = 128,
  thumb
}: {
  preset: LayoutPreset
  aspect: number
  /** Frame height in px; width follows the aspect. */
  height?: number
  thumb?: (cellIndex: number) => JSX.Element | null
}): JSX.Element {
  const width = Math.round(height * aspect)
  return (
    <div className="relative overflow-hidden rounded-md border border-white/15 bg-black" style={{ width, height }}>
      {preset.rects.map((rect: CellRect, i) => {
        const style = {
          left: `${(rect.x / FRAME.width) * 100}%`,
          top: `${(rect.y / FRAME.height) * 100}%`,
          width: `${(rect.w / FRAME.width) * 100}%`,
          height: `${(rect.h / FRAME.height) * 100}%`
        }
        const content = thumb?.(i)
        return (
          <div
            key={i}
            className="absolute flex items-center justify-center overflow-hidden border border-white/25 bg-white/[0.04]"
            style={style}
          >
            {content ?? <span className="text-[11px] font-semibold text-zinc-500">{i + 1}</span>}
          </div>
        )
      })}
    </div>
  )
}
