import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, IPC_EVENT, type AudioFxRequest, type LaunchState, type LoadedProject, type RemoveBackgroundRequest, type StillRequest } from '@shared/ipc'
import type { FfmpegCapabilities } from '@shared/ffmpeg'
import type { MediaAsset } from '@shared/media'
import type { JobProgressEvent } from '@shared/jobs'
import type { Project } from '@shared/project'
import type { PresetId } from '@shared/formats'
import type { Settings } from '@shared/settings'
import type { Transcript } from '@shared/transcript'
import type { AssistantRequest, AssistantResponse, AssistantStatus } from '@shared/assistant/protocol'

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
  /** Pick a file holding a missing asset's original (null = canceled). */
  relinkMediaDialog: (id: string): Promise<MediaAsset | null> => ipcRenderer.invoke(IPC.relinkMediaDialog, id),

  // Project (M2) — a project is a folder (docs/MEDIA-POINTERS.md).
  // loadProject/saveProject read/write its working copy (autosave); the *File*
  // methods create, open and save it.
  /** What to open at launch: the last project, or none (start screen). */
  loadProject: (): Promise<LaunchState> => ipcRenderer.invoke(IPC.loadProject),
  saveProject: (project: Project): Promise<void> => ipcRenderer.invoke(IPC.saveProject, project),
  openProjectFile: (): Promise<LoadedProject | null> => ipcRenderer.invoke(IPC.openProjectFile),
  saveProjectAs: (project: Project): Promise<{ path: string; project: Project } | null> =>
    ipcRenderer.invoke(IPC.saveProjectAs, project),
  saveProjectFile: (project: Project): Promise<Project> => ipcRenderer.invoke(IPC.saveProjectFile, project),
  /** File ▸ New: create `<location>/<name>/` and open it (rejects with a reason). */
  createProject: (name: string, location: string): Promise<LoadedProject> =>
    ipcRenderer.invoke(IPC.createProject, name, location),
  /** The New window's "Choose location…" folder picker (null = canceled). */
  chooseProjectLocation: (current: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.chooseProjectLocation, current),
  /** Where the New window starts: the Settings export folder. */
  defaultProjectLocation: (): Promise<string> => ipcRenderer.invoke(IPC.defaultProjectLocation),
  /** The open project's folder (null when none is open). */
  getProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.getProjectDir),
  /** A library record changed after the project opened: it has unsaved changes. */
  onLibraryChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(IPC_EVENT.libraryChanged, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.libraryChanged, handler)
  },
  /** File ▸ Convert old projects…: summary lines, or null if canceled. */
  convertLegacyFolderDialog: (): Promise<string[] | null> => ipcRenderer.invoke(IPC.convertLegacyFolderDialog),

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

  // Background removal (subject-aware crop) — matte one clip segment into a new
  // transparent library asset (a VP9 WebM with the segment's audio), gated on the
  // segmentation model being present. Resolves null when the job was canceled.
  segmentAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.segmentAvailable),
  removeBackground: (req: RemoveBackgroundRequest): Promise<MediaAsset | null> =>
    ipcRenderer.invoke(IPC.removeBackground, req),
  /** Ask a cancelable background job to stop (false = nothing to cancel). */
  cancelJob: (jobId: string): Promise<boolean> => ipcRenderer.invoke(IPC.cancelJob, jobId),
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
  },

  // AI assistant: main asks the renderer to run store ops; the renderer answers.
  onAssistantRequest: (cb: (req: AssistantRequest) => void): (() => void) => {
    const handler = (_e: unknown, req: AssistantRequest): void => cb(req)
    ipcRenderer.on(IPC_EVENT.assistantRequest, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.assistantRequest, handler)
  },
  assistantRespond: (res: AssistantResponse): void => ipcRenderer.send(IPC.assistantResponse, res),
  assistantStatus: (): Promise<AssistantStatus> => ipcRenderer.invoke(IPC.assistantStatus)
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
