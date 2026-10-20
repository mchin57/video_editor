/** Timeline ▸ the fixed left gutter: one header bubble per lane. Drag a bubble
 *  (or its bottom-edge handle) to resize the lane, use the chevron or
 *  double-click to collapse it; the Captions bubble also selects the lane-wide
 *  caption style. Guarded by e2e/timelineInteractions.spec.ts. */

import type { JSX, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { LaneBox } from '@/lib/lanes'
import { GUTTER, LANE_STYLE, RULER_H, type LaneKey } from './constants'

export function LaneGutter({
  lanes,
  totalH,
  gutterRef,
  captionsGlobalSelected,
  onCaptionLanePress,
  onResizeStart,
  onToggleCollapsed
}: {
  lanes: LaneBox<LaneKey>[]
  totalH: number
  /** Moved by the track's vertical scroll (`useGutterSync`). */
  gutterRef: RefObject<HTMLDivElement | null>
  captionsGlobalSelected: boolean
  onCaptionLanePress: () => void
  onResizeStart: (e: ReactPointerEvent, key: LaneKey, rows: number) => void
  onToggleCollapsed: (key: LaneKey) => void
}): JSX.Element {
  return (
    <div
      className="relative shrink-0 overflow-hidden border-r border-white/10 bg-zinc-900/50"
      style={{ width: GUTTER }}
    >
      <div
        ref={gutterRef}
        data-testid="timeline-gutter"
        className="absolute inset-x-0 top-0 will-change-transform"
        style={{ height: totalH }}
      >
        <div
          className="absolute inset-x-0 top-0 flex items-center border-b border-white/10 px-2"
          style={{ height: RULER_H }}
        >
          <span className="text-[8px] font-semibold uppercase tracking-wider text-zinc-600">Tracks</span>
        </div>
        {lanes.map((lane) => {
          const st = LANE_STYLE[lane.key]
          // The Captions label is also a control: click it to edit the
          // lane-wide caption style (every caption without its own override).
          const isCaption = lane.key === 'caption'
          const selected = isCaption && captionsGlobalSelected
          return (
            <div
              key={lane.key}
              data-testid={`lane-${lane.key}`}
              // Drag the bubble body vertically to resize; double-click to
              // collapse/expand. Caption bubbles also select on press.
              onPointerDown={(e) => {
                if (isCaption) onCaptionLanePress()
                if (!lane.collapsed) onResizeStart(e, lane.key, lane.rows)
              }}
              onDoubleClick={() => onToggleCollapsed(lane.key)}
              title={`${isCaption ? 'Click to edit all captions · ' : ''}drag to resize · double-click to collapse`}
              className={`absolute inset-x-1 flex select-none items-center gap-1 overflow-hidden rounded-md border px-1 ${st.tint} ${
                lane.collapsed ? 'cursor-pointer' : 'cursor-ns-resize'
              } ${isCaption ? 'hover:brightness-125' : ''} ${selected ? st.sel : ''}`}
              style={{ top: lane.top + 1, height: Math.max(0, lane.height - 2) }}
            >
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={() => onToggleCollapsed(lane.key)}
                title={lane.collapsed ? 'Expand lane' : 'Collapse lane'}
                className="shrink-0 text-[9px] leading-none text-zinc-400 hover:text-zinc-100"
              >
                {lane.collapsed ? '▸' : '▾'}
              </button>
              <span className={`h-2 w-2 shrink-0 rounded-sm ${st.dot}`} />
              <span className="truncate text-[10px] font-medium leading-none text-zinc-200">{lane.label}</span>
              {isCaption && !lane.collapsed && <span className="ml-auto text-[9px] text-emerald-300/80">✎</span>}
              {/* Bottom-edge resize handle (hidden while collapsed). */}
              {!lane.collapsed && (
                <div
                  onPointerDown={(e) => onResizeStart(e, lane.key, lane.rows)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  data-testid={`lane-resize-${lane.key}`}
                  title="Drag to resize lane"
                  className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-white/30"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
