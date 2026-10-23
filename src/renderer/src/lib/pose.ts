/**
 * The pose actions on a video clip: run the detection job for the footage it
 * plays (and point the clip's overlay at the result), and copy the skeleton on
 * screen into a graphics tile ("Convert to drawing") for hand annotation.
 */

import type { QueryClient } from '@tanstack/react-query'
import type { Layer, VideoContent } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { layerTransformAt, makeGraphicsLayer, stretchedBox, videoSourceTime, videoSourceWindow } from '@shared/layers'
import { angleMark, newMark, type GraphicMark } from '@shared/graphics'
import {
  POSE_ANGLES,
  POSE_LINKS,
  POSE_MIN_SCORE,
  clipPoseView,
  defaultPoseSettings,
  personAt,
  remapPicks,
  remapTracks,
  validPicks,
  toView,
  viewToCanvas,
  type PoseData
} from '@shared/pose'
import { normalizeDeg } from '@shared/rotation'
import { slowestSpeedBetween } from '@shared/speed'
import { newId } from '@shared/ids'
import { detectPose, getPose } from '@/ipc/client'
import { invalidatePose } from '@/hooks/usePose'
import { getActiveComp, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { idle } from './interaction'

export type PoseDetectOutcome = 'done' | 'canceled' | 'clip-changed'

/**
 * Detect poses over the footage this clip plays (main grows the window to keep
 * any other clip of the same file covered, and samples slow-mo more densely).
 * A re-detection renumbers people, so EVERY clip of the file — anywhere in the
 * project — has its picks carried over by matching old people to new
 * (`remapTracks`), in one undo step. This clip then shows its overlay; if it
 * had nobody picked (or nobody could be matched) it starts on the most
 * prominent person in its own footage.
 */
export async function detectLayerPose(layerId: string, qc: QueryClient): Promise<PoseDetectOutcome> {
  const layer = getActiveComp()?.layers.find((l) => l.id === layerId)
  if (!layer || layer.content.kind !== 'video') throw new Error('Select a video clip first.')
  const c = layer.content
  const window = videoSourceWindow(c)
  const prev = await getPose(c.mediaId)
  const data = await detectPose({
    mediaId: c.mediaId,
    startSec: window.startSec,
    durationSec: window.durationSec,
    minSpeed: slowestSpeedBetween(c, c.inSec, c.outSec),
    subjectId: layerId
  })
  if (!data) return 'canceled'
  await invalidatePose(qc, c.mediaId)
  await idle() // the job can finish mid-drag; the edit waits for the release
  const now = getActiveComp()?.layers.find((l) => l.id === layerId)
  if (!now || now.content.kind !== 'video' || now.content.mediaId !== c.mediaId) return 'clip-changed'
  const map = prev ? remapTracks(prev, data) : null
  useProject.getState().updateMediaPose(c.mediaId, (pose, l) => {
    const carried = pose ? (map ? remapPicks(pose, map) : validPicks(pose, data)) : pose
    if (l.id !== layerId) return carried
    const vc = l.content as VideoContent
    const fresh = defaultPoseSettings(data, { inSec: vc.inSec, outSec: vc.outSec })
    if (!carried) return fresh
    return { ...carried, show: true, people: carried.people.length ? carried.people : fresh.people }
  })
  return 'done'
}

/**
 * The skeleton(s) on screen now, as a new graphics tile (3s at the playhead):
 * one line mark per visible limb and an angle mark per chosen angle, in each
 * person's colour, placed exactly where the clip shows them (its position,
 * zoom, stretch and rotation at this instant). Returns the tile's id, or null
 * when nobody is visible.
 */
export function poseToGraphics(
  layer: Layer,
  content: VideoContent,
  asset: MediaAsset,
  data: PoseData,
  time: number
): string | null {
  const v = asset.probe.video
  const settings = content.pose
  if (!v || !settings) return null
  const view = clipPoseView(content, data, { w: v.displayWidth, h: v.displayHeight })
  const src = videoSourceTime(content, layer, time)
  // The clip's box right now (its keyframed position and zoom).
  const tr = layerTransformAt(layer, time)
  const box = stretchedBox(view.crop.w / view.crop.h, tr.scale, layer.stretchX ?? 1, layer.stretchY ?? 1)
  const rot = layer.rotationDeg ? normalizeDeg(layer.rotationDeg) : 0
  const marks: GraphicMark[] = []
  for (const person of settings.people) {
    const k = personAt(data, person, src)
    if (!k) continue
    const seen = (i: number): boolean => k[i * 3 + 2] >= POSE_MIN_SCORE
    const at = (i: number): { x: number; y: number } =>
      viewToCanvas(toView(view, k[i * 3], k[i * 3 + 1]), view, { x: tr.x, y: tr.y }, box, rot)
    const width = Math.max(2, settings.widthPx * tr.scale)
    for (const [a, b] of POSE_LINKS) {
      if (!seen(a) || !seen(b)) continue
      marks.push({ ...newMark('line', newId(), at(a), at(b), 0), color: person.color, widthPx: width })
    }
    for (const id of settings.angles) {
      const d = POSE_ANGLES[id]
      if (!seen(d.a) || !seen(d.vertex) || !seen(d.b)) continue
      marks.push({ ...angleMark(newId(), at(d.vertex), at(d.a), at(d.b), 0), color: person.color, widthPx: width })
    }
  }
  if (!marks.length) return null
  const tile = makeGraphicsLayer(newId(), time, time + 3)
  useProject.getState().addLayer({ ...tile, content: { kind: 'graphics', marks } })
  useUi.getState().selectLayer(tile.id)
  return tile.id
}
