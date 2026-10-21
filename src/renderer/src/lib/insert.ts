/**
 * The Insert actions: a new text layer, caption or graphics tile at the
 * playhead, selected so the Inspector opens on it. ONE home for them — the
 * header's Insert menu and the `T` shortcut both call these.
 */

import { makeGraphicsLayer, makeTextLayer } from '@shared/layers'
import { GRAPHICS_DEFAULT_SEC } from '@shared/graphics'
import { newId } from '@shared/ids'
import { getFormat, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { makeCaption } from '@/lib/captions'

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
