import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { MediaAsset } from '@shared/media'
import type { Project } from '@shared/project'
import { getCapabilities } from './services/ffmpeg'
import { getDataDir } from './config'
import { ensureProxy, importFile, listLibrary, removeMedia } from './services/mediaStore'
import { loadProject, saveProject } from './services/projectStore'

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
}
