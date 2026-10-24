/** IPC: exporting the edit, revealing a file, and capturing stills. */

import { app, shell } from 'electron'
import { join, parse } from 'node:path'
import type { StillRequest } from '@shared/ipc'
import type { MediaAsset } from '@shared/media'
import { alphaInputDecoder } from '@shared/media'
import { exportProject, suggestedExportName } from '../services/exporter'
import { getSettings } from '../services/settings'
import { generateStill } from '../services/still'
import { hdrToSdrChain } from '../services/proxy'
import { cropFilter, gradeFilter } from '../services/ffmpegFilters'
import { importGenerated, requireUsable, tmpOutput } from '../services/mediaStore'
import { requireSession } from '../services/projectSession'
import { dialogsFor, handle } from './handle'

/** ffmpeg -vf chain to make a still match the preview (HDR → SDR, crop, color). */
function stillVfChain(asset: MediaAsset, req: StillRequest): string[] {
  const chain: string[] = []
  const v = asset.probe.video
  if (v?.isHdr) chain.push(hdrToSdrChain(v))
  if (req.crop) chain.push(cropFilter(req.crop))
  if (req.flipH) chain.push('hflip')
  if (req.flipV) chain.push('vflip')
  const grade = gradeFilter(req.color, req.tint)
  if (grade) chain.push(grade)
  return chain
}

/** Render the still `req` asks for into `out`. */
const renderStill = (asset: MediaAsset, req: StillRequest, out: string): Promise<void> =>
  generateStill(asset.originalPath, out, req.sourceSec, stillVfChain(asset, req), alphaInputDecoder(asset.probe.video))

export function registerExportHandlers(): void {
  handle('exportProject', async (event, project, opts) => {
    const settings = await getSettings()
    const result = await dialogsFor(event).save({
      title: 'Export Reel',
      defaultPath: join(settings.exportDir, suggestedExportName(project.name, opts.preset)),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    return exportProject(project, opts, result.filePath)
  })

  handle('revealFile', (_event, path) => {
    shell.showItemInFolder(path)
    return true
  })

  // Stills: capture an exact frame from a clip, matching the preview's HDR
  // tonemap / crop / color, into the library or to a user-chosen file.
  handle('captureStillToLibrary', async (_event, req) => {
    const session = requireSession()
    const asset = await requireUsable(req.mediaId, session)
    const out = tmpOutput('still', 'png')
    await renderStill(asset, req, out)
    return importGenerated(out, `${parse(asset.fileName).name} (still).png`, session)
  })

  handle('captureStillToDisk', async (event, req, suggestedName) => {
    const asset = await requireUsable(req.mediaId)
    const result = await dialogsFor(event).save({
      title: 'Save still frame',
      defaultPath: join(app.getPath('pictures'), suggestedName || 'still.png'),
      filters: [
        { name: 'PNG image', extensions: ['png'] },
        { name: 'JPEG image', extensions: ['jpg'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    await renderStill(asset, req, result.filePath)
    return result.filePath
  })
}
