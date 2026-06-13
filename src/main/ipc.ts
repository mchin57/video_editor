import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { MediaAsset } from '@shared/media'
import type { Project } from '@shared/project'
import type { PresetId } from '@shared/export'
import { getCapabilities } from './services/ffmpeg'
import { getDataDir } from './config'
import { ensureProxy, importFile, listLibrary, removeMedia } from './services/mediaStore'
import { loadProject, saveProject } from './services/projectStore'
import { exportProject, suggestedExportName } from './services/exporter'
import { getSettings, updateSettings } from './services/settings'
import { getTranscript, transcribeMedia, whisperAvailable } from './services/whisper'

const VIDEO_EXTS = [
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'hevc', '3gp', 'wmv', 'flv', 'mts', 'm2ts', 'mpg', 'mpeg'
]

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
      title: 'Import video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTS },
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

  ipcMain.handle(IPC.getSettings, () => getSettings())
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
