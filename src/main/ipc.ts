import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, parse } from 'node:path'
import { IPC, type AudioFxRequest, type StillRequest } from '@shared/ipc'
import type { MediaAsset } from '@shared/media'
import { alphaInputDecoder, AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from '@shared/media'
import type { Project } from '@shared/project'
import { isNeutralColor } from '@shared/project'
import type { PresetId } from '@shared/export'
import { getCapabilities } from './services/ffmpeg'
import { getDataDir, getSubdir } from './config'
import { generateStill } from './services/still'
import { hdrToSdrChain } from './services/proxy'
import { cropFilter, eqFilter } from './services/ffmpegFilters'
import {
  ensureProxy,
  extractAudioToLibrary,
  getAsset,
  getProjectMedia,
  importFile,
  renderAudioFxToLibrary
} from './services/mediaStore'
import {
  loadProject,
  readProjectFile,
  REEL_EXT,
  saveProject,
  writeProjectFile
} from './services/projectStore'
import { exportProject, suggestedExportName } from './services/exporter'
import type { Settings } from '@shared/settings'
import { getSettings, updateSettings } from './services/settings'
import { getTranscript, transcribeMedia, whisperAvailable } from './services/whisper'
import { detectSilence, type Interval } from './services/silence'
import { removeBackgroundToLibrary, segmentAvailable } from './services/removeBackground'

/** Import each path (fast hash+probe), then kick proxy generation in the background. */
async function importMany(paths: string[]): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = []
  for (const path of paths) {
    try {
      const asset = await importFile(path)
      assets.push(asset)
      if (!asset.proxyReady) {
        void ensureProxy(asset.id).catch((err) => console.error('proxy generation failed', err))
      }
    } catch (err) {
      console.error('import failed for', path, err)
    }
  }
  return assets
}

/** ffmpeg -vf chain to make a still match the preview (HDR → SDR, crop, color). */
function stillVfChain(asset: MediaAsset, req: StillRequest): string[] {
  const chain: string[] = []
  const v = asset.probe.video
  if (v?.isHdr) chain.push(hdrToSdrChain(v))
  if (req.crop) chain.push(cropFilter(req.crop))
  if (req.color && !isNeutralColor(req.color)) chain.push(eqFilter(req.color))
  return chain
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getCapabilities, () => getCapabilities())
  ipcMain.handle(IPC.getDataDir, () => getDataDir())

  ipcMain.handle(IPC.importDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS] },
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'Audio', extensions: AUDIO_EXTS },
        { name: 'Images', extensions: IMAGE_EXTS },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return importMany(result.filePaths)
  })

  ipcMain.handle(IPC.importPaths, (_event, paths: string[]) => importMany(paths))

  // Pick a video (or any media) file and pull its audio track into the library as
  // a standalone audio asset — no timeline placement required.
  ipcMain.handle(IPC.extractAudioDialog, async (event): Promise<MediaAsset | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Extract audio from clip',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return extractAudioToLibrary(result.filePaths[0])
  })

  ipcMain.handle(IPC.listProjectMedia, (_event, ids: string[]) => getProjectMedia(ids))
  ipcMain.handle(IPC.ensureProxy, (_event, id: string) => ensureProxy(id))

  ipcMain.handle(IPC.loadProject, () => loadProject())
  ipcMain.handle(IPC.saveProject, (_event, project: Project) => saveProject(project))

  // Open a portable .reel file via a native dialog. The on-disk filename becomes
  // the project's name (so exports and the title bar stay in sync with the file).
  ipcMain.handle(IPC.openProjectFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open project',
      properties: ['openFile'],
      filters: [
        { name: 'Reel Project', extensions: [REEL_EXT] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const project = await readProjectFile(path)
    return { path, project: { ...project, name: parse(path).name } }
  })

  // Save As… — native Save dialog, then write. Returns the chosen path + the
  // saved doc (its name/updatedAt updated to match the file).
  ipcMain.handle(IPC.saveProjectAs, async (event, project: Project) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const base = (project.name || '').trim() || 'Untitled Reel'
    const options: Electron.SaveDialogOptions = {
      title: 'Save project as',
      defaultPath: join(app.getPath('documents'), `${base}.${REEL_EXT}`),
      filters: [{ name: 'Reel Project', extensions: [REEL_EXT] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const path = result.filePath
    const saved = await writeProjectFile(path, { ...project, name: parse(path).name })
    return { path, project: saved }
  })

  // Save to an already-bound path (no dialog). Returns the saved doc.
  ipcMain.handle(IPC.writeProjectFile, (_event, project: Project, path: string) =>
    writeProjectFile(path, project)
  )

  ipcMain.handle(
    IPC.exportProject,
    async (event, project: Project, opts: { preset: PresetId; preferNvenc: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const settings = await getSettings()
      const defaultPath = join(settings.exportDir, suggestedExportName(project.name, opts.preset))
      const options: Electron.SaveDialogOptions = {
        title: 'Export Reel',
        defaultPath,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      return exportProject(project, opts, result.filePath)
    }
  )
  ipcMain.handle(IPC.revealFile, (_event, path: string) => {
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle(IPC.whisperAvailable, () => whisperAvailable())
  ipcMain.handle(IPC.transcribeMedia, (_event, mediaId: string) => transcribeMedia(mediaId))
  ipcMain.handle(IPC.getTranscript, (_event, mediaId: string) => getTranscript(mediaId))

  ipcMain.handle(IPC.detectSilence, async (_event, mediaId: string): Promise<Interval[]> => {
    const asset = await getAsset(mediaId)
    if (!asset) return []
    return detectSilence(asset.originalPath, asset.probe.durationSec)
  })

  // Background removal: matte a clip into a new transparent library asset.
  ipcMain.handle(IPC.segmentAvailable, () => segmentAvailable())
  ipcMain.handle(IPC.removeBackground, (_event, mediaId: string) => removeBackgroundToLibrary(mediaId))
  ipcMain.handle(IPC.renderAudioFx, (_event, req: AudioFxRequest) =>
    renderAudioFxToLibrary(req.settings, req.sourceMediaId, req.inSec, req.outSec)
  )

  // Stills: capture an exact frame from a clip, matching the preview's HDR
  // tonemap / crop / color, into the library or to a user-chosen file.
  ipcMain.handle(IPC.captureStillToLibrary, async (_event, req: StillRequest): Promise<MediaAsset> => {
    const asset = await getAsset(req.mediaId)
    if (!asset) throw new Error('Source media not found for this still.')
    const base = parse(asset.fileName).name
    const out = join(getSubdir('stills'), `${base}-still-${Date.now().toString(36)}.png`)
    await generateStill(asset.originalPath, out, req.sourceSec, stillVfChain(asset, req), alphaInputDecoder(asset.probe.video))
    return importFile(out, `${base} (still).png`)
  })

  ipcMain.handle(
    IPC.captureStillToDisk,
    async (event, req: StillRequest, suggestedName: string): Promise<string | null> => {
      const asset = await getAsset(req.mediaId)
      if (!asset) throw new Error('Source media not found for this still.')
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = {
        title: 'Save still frame',
        defaultPath: join(app.getPath('pictures'), suggestedName || 'still.png'),
        filters: [
          { name: 'PNG image', extensions: ['png'] },
          { name: 'JPEG image', extensions: ['jpg'] }
        ]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      await generateStill(asset.originalPath, result.filePath, req.sourceSec, stillVfChain(asset, req), alphaInputDecoder(asset.probe.video))
      return result.filePath
    }
  )

  ipcMain.handle(IPC.getSettings, () => getSettings())
  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<Settings>) => updateSettings(patch))
  ipcMain.handle(IPC.chooseExportDir, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose default export folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return getSettings()
    return updateSettings({ exportDir: result.filePaths[0] })
  })
}
