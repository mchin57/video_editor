/** IPC: the shared library — list, add files (a picker or a library clip),
 *  save text, rename, delete, and copying an item into the open project
 *  (services/sharedLibrary.ts; docs/SHARED-LIBRARY.md). */

import { parse } from 'node:path'
import { SHARED_KIND_LABELS, sharedExtsFor } from '@shared/sharedLibrary'
import { probeFile } from '../services/ffprobe'
import { copyIntoProject, requireUsable } from '../services/mediaStore'
import { requireSession } from '../services/projectSession'
import {
  addSharedFiles,
  deleteShared,
  listShared,
  renameShared,
  saveSharedText,
  sharedFile,
  sharedRoot,
  type SharedDeps
} from '../services/sharedLibrary'
import { generateThumbnail } from '../services/thumbnail'
import { dialogsFor, handle } from './handle'

const deps: SharedDeps = { probe: probeFile, thumbnail: generateThumbnail }

export function registerSharedLibraryHandlers(): void {
  handle('listShared', () => listShared(sharedRoot()))

  handle('addSharedFilesDialog', async (event, kind) => {
    const res = await dialogsFor(event).open({
      title: `Add to shared ${SHARED_KIND_LABELS[kind].toLowerCase()}`,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: SHARED_KIND_LABELS[kind], extensions: [...sharedExtsFor(kind)] }]
    })
    if (res.canceled || !res.filePaths.length) return null
    return addSharedFiles(sharedRoot(), res.filePaths, deps, kind)
  })

  handle('addSharedFromLibrary', async (_event, mediaId) => {
    // The library's display name, not the file's (a renamed or generated clip).
    const asset = await requireUsable(mediaId, requireSession())
    const name = parse(asset.fileName).name || undefined
    return addSharedFiles(sharedRoot(), [asset.originalPath], deps, undefined, () => name)
  })

  handle('saveSharedText', (_event, name, layers) => saveSharedText(sharedRoot(), name, layers))
  handle('renameShared', (_event, id, name) => renameShared(sharedRoot(), id, name))
  handle('deleteShared', (_event, id) => deleteShared(sharedRoot(), id))

  handle('instantiateShared', async (_event, id) => {
    // The project gets its OWN copy (in generated/), so it never points into
    // the shared folder; inserting the same item again reuses that copy
    // (importGenerated dedupes by fingerprint).
    const s = requireSession()
    const { path, displayName } = await sharedFile(sharedRoot(), id)
    return copyIntoProject(path, displayName, s)
  })
}
