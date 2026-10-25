/**
 * The Insert actions: a new text layer, caption or graphics tile — or a
 * template — at the playhead, selected so the Inspector opens on it. ONE home
 * for them — the header's Insert menu, the `T` shortcut and the template
 * gallery call these.
 */

import { makeGraphicsLayer, makeTextLayer } from '@shared/layers'
import { GRAPHICS_DEFAULT_SEC } from '@shared/graphics'
import { newId } from '@shared/ids'
import { getFormat, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { makeCaption } from '@/lib/captions'
import { idle } from '@/lib/interaction'
import type { DropMedia } from '@/lib/templates'
import { instantiateTemplate } from '@/ipc/client'

/** A text layer at the playhead (3s), a third of the way down the frame. */
export function insertText(): void {
  const id = newId()
  const start = usePlayback.getState().time
  useProject.getState().addLayer(makeTextLayer(id, start, start + 3, getFormat().frame))
  useUi.getState().selectLayer(id)
}

/** A caption at the playhead (2s), in the lane-wide caption style like every
 *  other (adding one turns the caption lane on). */
export function insertCaption(): void {
  const id = newId()
  const start = usePlayback.getState().time
  useProject.getState().addCaption(makeCaption(id, start, start + 2))
  useUi.getState().selectCaption(id)
}

/** An empty graphics tile at the playhead; its marks are added from the
 *  Inspector's drawing tools. */
export function insertGraphics(): void {
  const id = newId()
  const start = usePlayback.getState().time
  useProject.getState().addLayer(makeGraphicsLayer(id, start, start + GRAPHICS_DEFAULT_SEC))
  useUi.getState().selectLayer(id)
}

/**
 * Drop template `id` at the playhead (where it was when this was called): main
 * copies its media into the project's library first, then the store adds them
 * and places the template (`dropTemplate`) — ONE undo step for both. `library`
 * gives the library's source lengths and frame rates (a whole-source audio
 * clip needs a length to be cut; the held frame is cut by frame rate).
 * Resolves whether its clip effect found no clip under the playhead.
 */
export async function insertTemplate(id: string, library: DropMedia): Promise<{ effectSkipped: boolean }> {
  const at = usePlayback.getState().time
  const { template, assets } = await instantiateTemplate(id)
  await idle() // the copy can finish mid-drag
  const store = useProject.getState()
  const fresh = new Map(assets.map((a) => [a.id, a]))
  const media: DropMedia = {
    durationOf: (m) => fresh.get(m)?.probe.durationSec ?? library.durationOf(m),
    fpsOf: (m) => fresh.get(m)?.probe.video?.avgFps ?? library.fpsOf(m)
  }
  // A gesture, so adding the media and placing the template undo together.
  store.beginGesture()
  try {
    if (assets.length) store.addMedia(assets.map((a) => a.id))
    return store.dropTemplate(template, at, media)
  } finally {
    store.endGesture()
  }
}
