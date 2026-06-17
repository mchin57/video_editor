import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join, parse } from 'node:path'
import { IPC } from '@shared/ipc'
import type { MediaAsset } from '@shared/media'
import type { Project } from '@shared/project'
import type { PresetId } from '@shared/export'
import { getCapabilities } from './services/ffmpeg'
import { getDataDir } from './config'
import { ensureProxy, getAsset, importFile, listLibrary, removeMedia } from './services/mediaStore'
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

const VIDEO_EXTS = [
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'hevc', '3gp', 'wmv', 'flv', 'mts', 'm2ts', 'mpg', 'mpeg'
]
const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma']

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

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getCapabilities, () => getCapabilities())
  ipcMain.handle(IPC.getDataDir, () => getDataDir())

  ipcMain.handle(IPC.importDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS] },
        { name: 'Video', extensions: VIDEO_EXTS },
        { name: 'Audio', extensions: AUDIO_EXTS },
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
  ipcMain.handle(IPC.listLibrary, () => listLibrary())
  ipcMain.handle(IPC.ensureProxy, (_event, id: string) => ensureProxy(id))
  ipcMain.handle(IPC.removeMedia, (_event, id: string) => removeMedia(id))

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
