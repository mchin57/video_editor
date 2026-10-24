/** Preview ▸ pose: a video clip's body-pose overlay, drawn from the shared `clipPoseShapes` inside the clip's box, and — while picking — every detected person as a numbered box to click. */

import { type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { Layer, VideoContent } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { LABEL_FONT_FAMILY, shapeSvg } from '@shared/graphics'
import { videoSourceTime } from '@shared/layers'
import {
  POSE_DEFAULT_WIDTH,
  clipPoseShapes,
  clipPoseView,
  togglePersonTrack,
  trackBoxesAt,
  type PoseSettings
} from '@shared/pose'
import { usePoseData } from '@/hooks/usePose'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'

/**
 * The overlay fills the clip's box (inside its rotation and zoom; flips are in
 * the view mapping, so labels never read mirrored) in the clip's VIEW space —
 * the same space the export renders its overlay in. The pose shown is at the
 * clip's SOURCE time (`videoSourceTime`), so freezes, speed and trims keep it
 * on the athlete.
 */
export function PoseOverlay({
  layer,
  content,
  asset,
  time,
  editable
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset
  time: number
  editable: boolean
}): JSX.Element | null {
  const picking = useUi((s) => s.posePickLayerId === layer.id) && editable
  const settings = content.pose ?? null
  const data = usePoseData(content.mediaId, !!settings || picking)
  const v = asset.probe.video
  if (!data || !v || (!settings?.show && !picking)) return null
  const view = clipPoseView(content, data, { w: v.displayWidth, h: v.displayHeight })
  const src = videoSourceTime(content, layer, time)
  const html = settings
    ? clipPoseShapes(data, settings, src, view)
        .map((s) => shapeSvg(s, LABEL_FONT_FAMILY))
        .join('')
    : ''

  const toggle = (e: ReactPointerEvent, trackId: number): void => {
    e.stopPropagation()
    e.preventDefault()
    const base: PoseSettings = settings ?? { show: true, people: [], angles: [], widthPx: POSE_DEFAULT_WIDTH }
    useProject.getState().updateLayerContent(layer.id, { pose: togglePersonTrack(base, trackId) })
  }

  return (
    <svg
      data-testid="pose-overlay"
      viewBox={`0 0 ${view.size.w} ${view.size.h}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none'
      }}
    >
      <g dangerouslySetInnerHTML={{ __html: html }} />
      {picking &&
        trackBoxesAt(data, src, view).map((b) => {
          const person = settings?.people.find((p) => p.tracks.includes(b.id))
          const stroke = person?.color ?? '#FFFFFF'
          return (
            <g
              key={b.id}
              data-testid={`pose-pick-${b.id}`}
              onPointerDown={(e) => toggle(e, b.id)}
              pointerEvents="all"
              style={{ cursor: 'pointer' }}
            >
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                fill={person ? `${stroke}22` : 'rgba(255,255,255,0.04)'}
                stroke={stroke}
                strokeWidth={4}
                strokeDasharray={person ? undefined : '14 10'}
              />
              <text
                x={b.x + 10}
                y={b.y + 44}
                fill={stroke}
                fontSize={40}
                fontFamily={LABEL_FONT_FAMILY}
                stroke="#000000"
                strokeWidth={5}
                paintOrder="stroke"
              >
                {b.id}
              </text>
            </g>
          )
        })}
    </svg>
  )
}
