/**
 * "Remove background" for one video layer, start to finish. Mattes ONLY the
 * source window the layer plays (`videoSourceWindow`) as a background job, then
 * swaps the transparent result in for the layer in place
 * (`applyBackgroundRemoval` → `rebaseVideoContent`): same lane, same timeline
 * position and duration, one undo step back to the original.
 *
 * Lives outside the Inspector on purpose: the job runs for minutes and the
 * user keeps editing — selecting another layer unmounts the Inspector section,
 * but the swap must still land when the job finishes.
 */

import type { MediaAsset } from '@shared/media'
import { videoSourceWindow } from '@shared/layers'
import { slowestSpeedBetween } from '@shared/speed'
import { removeBackground } from '@/ipc/client'
import { getActiveComp, useProject } from '@/state/projectStore'

/**
 * - `replaced`: the layer now plays the matte.
 * - `canceled`: the job was canceled; nothing changed.
 * - `kept-in-library`: the matte finished but could not be swapped in (the
 *   layer was deleted or re-trimmed past the matted window meanwhile, or its
 *   preview failed); the transparent clip is in the library to place by hand.
 * - `project-changed`: another project was opened meanwhile; nothing changed.
 */
export type BackgroundRemovalOutcome = 'replaced' | 'canceled' | 'kept-in-library' | 'project-changed'

export async function removeLayerBackground(layerId: string, source: MediaAsset): Promise<BackgroundRemovalOutcome> {
  const { project, editPath } = useProject.getState()
  const layer = getActiveComp()?.layers.find((l) => l.id === layerId)
  if (!project || !layer || layer.content.kind !== 'video') throw new Error('Select a video clip first.')
  const c = layer.content
  const window = videoSourceWindow(c)
  const matte = await removeBackground({
    mediaId: c.mediaId,
    startSec: window.startSec,
    durationSec: window.durationSec,
    minSpeed: slowestSpeedBetween(c, c.inSec, c.outSec),
    subjectId: layerId
  })
  if (!matte) return 'canceled'

  const store = useProject.getState()
  if (store.project?.id !== project.id) return 'project-changed'
  store.addMedia([matte.id]) // the transparent copy is a library clip either way
  const sv = source.probe.video
  const mv = matte.probe.video
  if (!matte.proxyReady || !sv || !mv || !sv.displayWidth || !sv.displayHeight) return 'kept-in-library'
  const applied = store.applyBackgroundRemoval(editPath, layerId, {
    sourceMediaId: c.mediaId,
    window,
    mediaId: matte.id,
    pixelScale: { x: mv.displayWidth / sv.displayWidth, y: mv.displayHeight / sv.displayHeight },
    size: { w: mv.displayWidth, h: mv.displayHeight }
  })
  return applied ? 'replaced' : 'kept-in-library'
}
