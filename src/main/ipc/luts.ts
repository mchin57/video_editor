/** IPC: colour LUTs in the open project's `luts/` — read one for the preview,
 *  import one (a picker), and move one to / from the shared library
 *  (services/luts.ts; shared/cube.ts). */

import { lutPath } from '../services/projectLayout'
import { importLut, readLut } from '../services/luts'
import { requireSession } from '../services/projectSession'
import { addSharedFiles, sharedFile, sharedRoot, type SharedDeps } from '../services/sharedLibrary'
import { probeFile } from '../services/ffprobe'
import { generateThumbnail } from '../services/thumbnail'
import { dialogsFor, handle, pickedPath } from './handle'

const deps: SharedDeps = { probe: probeFile, thumbnail: generateThumbnail }

export function registerLutHandlers(): void {
  handle('readLut', (_event, file) => readLut(requireSession().root, file))

  handle('importLutDialog', async (event) => {
    const path = pickedPath(
      await dialogsFor(event).open({
        title: 'Import LUT',
        properties: ['openFile'],
        filters: [{ name: 'Colour LUT (.cube)', extensions: ['cube'] }]
      })
    )
    return path ? importLut(requireSession().root, path) : null
  })

  handle('shareLut', async (_event, file, name) => {
    const path = lutPath(requireSession().root, file)
    if (!path) throw new Error(`“${file}” is not a LUT name this editor writes.`)
    return addSharedFiles(sharedRoot(), [path], deps, 'lut', () => name)
  })

  handle('copySharedLut', async (_event, id) => {
    const { path, displayName } = await sharedFile(sharedRoot(), id)
    const got = await importLut(requireSession().root, path)
    return { ...got, name: displayName.replace(/\.cube$/i, '') }
  })
}
