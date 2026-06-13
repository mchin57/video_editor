import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { getCapabilities } from './services/ffmpeg'
import { getDataDir } from './config'

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getCapabilities, () => getCapabilities())
  ipcMain.handle(IPC.getDataDir, () => getDataDir())
}
