import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type { FfmpegCapabilities } from '@shared/ffmpeg'

/** Typed surface exposed to the renderer as window.api. */
const api = {
  getCapabilities: (): Promise<FfmpegCapabilities> => ipcRenderer.invoke(IPC.getCapabilities),
  getDataDir: (): Promise<string> => ipcRenderer.invoke(IPC.getDataDir)
}

export type RendererApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define for non-isolated fallback)
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
