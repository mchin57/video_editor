import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, IPC_EVENT } from '@shared/ipc'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import type { MediaAsset } from '@shared/media'
import type { JobProgressEvent } from '@shared/jobs'
import type { Project } from '@shared/project'
import type { PresetId } from '@shared/export'
import type { Settings } from '@shared/settings'
import type { Transcript } from '@shared/transcript'

/** Typed surface exposed to the renderer as window.api. */
const api = {
  getCapabilities: (): Promise<FfmpegCapabilities> => ipcRenderer.invoke(IPC.getCapabilities),
  getDataDir: (): Promise<string> => ipcRenderer.invoke(IPC.getDataDir),

  // Media library (M1)
  importDialog: (): Promise<MediaAsset[]> => ipcRenderer.invoke(IPC.importDialog),
  importPaths: (paths: string[]): Promise<MediaAsset[]> => ipcRenderer.invoke(IPC.importPaths, paths),
  listLibrary: (): Promise<MediaAsset[]> => ipcRenderer.invoke(IPC.listLibrary),
  ensureProxy: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ensureProxy, id),
  removeMedia: (id: string): Promise<void> => ipcRenderer.invoke(IPC.removeMedia, id),

  // Project (M2)
  loadProject: (): Promise<Project> => ipcRenderer.invoke(IPC.loadProject),
  saveProject: (project: Project): Promise<void> => ipcRenderer.invoke(IPC.saveProject, project),

  // Export (M3) — returns the output path, or null if the Save dialog was canceled.
  exportProject: (
    project: Project,
    opts: { preset: PresetId; preferNvenc: boolean }
  ): Promise<string | null> => ipcRenderer.invoke(IPC.exportProject, project, opts),
  revealFile: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.revealFile, path),

  // Settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.updateSettings, patch),
  chooseExportDir: (): Promise<Settings> => ipcRenderer.invoke(IPC.chooseExportDir),

  // Captions (M4)
  whisperAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.whisperAvailable),
  transcribeMedia: (mediaId: string): Promise<Transcript> =>
    ipcRenderer.invoke(IPC.transcribeMedia, mediaId),
  getTranscript: (mediaId: string): Promise<Transcript | null> =>
    ipcRenderer.invoke(IPC.getTranscript, mediaId),

  /** Resolve a dropped File to its absolute path (Electron drag-and-drop). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Subscribe to background job progress. Returns an unsubscribe function. */
  onJobProgress: (cb: (ev: JobProgressEvent) => void): (() => void) => {
    const handler = (_e: unknown, ev: JobProgressEvent): void => cb(ev)
    ipcRenderer.on(IPC_EVENT.jobProgress, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.jobProgress, handler)
  }
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
