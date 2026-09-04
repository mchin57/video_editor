import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, IPC_EVENT, type AudioFxRequest, type StillRequest } from '@shared/ipc'
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
  importFolderDialog: (): Promise<MediaAsset[]> => ipcRenderer.invoke(IPC.importFolderDialog),
  extractAudioDialog: (): Promise<MediaAsset | null> => ipcRenderer.invoke(IPC.extractAudioDialog),
  listProjectMedia: (ids: string[]): Promise<MediaAsset[]> =>
    ipcRenderer.invoke(IPC.listProjectMedia, ids),
  ensureProxy: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ensureProxy, id),

  // Project (M2). loadProject/saveProject persist the working copy; the *File*
  // methods read/write user-chosen portable .reel files.
  loadProject: (): Promise<Project> => ipcRenderer.invoke(IPC.loadProject),
  saveProject: (project: Project): Promise<void> => ipcRenderer.invoke(IPC.saveProject, project),
  openProjectFile: (): Promise<{ path: string; project: Project } | null> =>
    ipcRenderer.invoke(IPC.openProjectFile),
  saveProjectAs: (project: Project): Promise<{ path: string; project: Project } | null> =>
    ipcRenderer.invoke(IPC.saveProjectAs, project),
  writeProjectFile: (project: Project, path: string): Promise<Project> =>
    ipcRenderer.invoke(IPC.writeProjectFile, project, path),

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
  detectSilence: (mediaId: string): Promise<{ start: number; end: number }[]> =>
    ipcRenderer.invoke(IPC.detectSilence, mediaId),

  // Background removal (subject-aware crop) — matte a clip into a new transparent
  // library asset (a VP9 WebM), gated on the segmentation model being present.
  segmentAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.segmentAvailable),
  removeBackground: (mediaId: string): Promise<MediaAsset> =>
    ipcRenderer.invoke(IPC.removeBackground, mediaId),
  renderAudioFx: (req: AudioFxRequest): Promise<MediaAsset> =>
    ipcRenderer.invoke(IPC.renderAudioFx, req),

  // Stills — capture a frame from a clip into the library, or save it to disk.
  captureStillToLibrary: (req: StillRequest): Promise<MediaAsset> =>
    ipcRenderer.invoke(IPC.captureStillToLibrary, req),
  captureStillToDisk: (req: StillRequest, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.captureStillToDisk, req, suggestedName),

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
