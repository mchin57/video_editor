import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  IPC_EVENT,
  type InvokeArgs,
  type InvokeName,
  type InvokeResult,
  type IpcEvents,
  type IpcSend
} from '@shared/ipc'

/** A typed caller for one invoke channel of the contract (`shared/ipc.ts`). */
const invoke =
  <K extends InvokeName>(name: K) =>
  (...args: InvokeArgs<K>): Promise<InvokeResult<K>> =>
    ipcRenderer.invoke(IPC[name], ...args)

/** A typed one-way message to main. */
const send =
  <K extends keyof IpcSend>(name: K) =>
  (...args: IpcSend[K]): void =>
    ipcRenderer.send(IPC[name], ...args)

/** Subscribe to one main → renderer event. Returns an unsubscribe function. */
const subscribe =
  <E extends keyof IpcEvents>(name: E) =>
  (cb: (...payload: IpcEvents[E]) => void): (() => void) => {
    const handler = (_e: unknown, ...payload: unknown[]): void => cb(...(payload as IpcEvents[E]))
    ipcRenderer.on(IPC_EVENT[name], handler)
    return () => ipcRenderer.removeListener(IPC_EVENT[name], handler)
  }

/** Typed surface exposed to the renderer as window.api. Signatures and their
 *  docs live in the contract (`IpcInvoke` in shared/ipc.ts). */
const api = {
  getCapabilities: invoke('getCapabilities'),
  getDataDir: invoke('getDataDir'),

  // Media library
  importDialog: invoke('importDialog'),
  importPaths: invoke('importPaths'),
  importFolderDialog: invoke('importFolderDialog'),
  extractAudioDialog: invoke('extractAudioDialog'),
  listProjectMedia: invoke('listProjectMedia'),
  ensureProxy: invoke('ensureProxy'),
  relinkMediaDialog: invoke('relinkMediaDialog'),
  renameMedia: invoke('renameMedia'),
  quickCut: invoke('quickCut'),
  mergeClips: invoke('mergeClips'),
  setMediaDescription: invoke('setMediaDescription'),
  /** Resolve a dropped File to its absolute path (Electron drag-and-drop). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Project
  loadProject: invoke('loadProject'),
  saveProject: invoke('saveProject'),
  openProjectFile: invoke('openProjectFile'),
  saveProjectAs: invoke('saveProjectAs'),
  saveProjectFile: invoke('saveProjectFile'),
  createProject: invoke('createProject'),
  chooseProjectLocation: invoke('chooseProjectLocation'),
  defaultProjectLocation: invoke('defaultProjectLocation'),
  getProjectDir: invoke('getProjectDir'),
  convertLegacyFolderDialog: invoke('convertLegacyFolderDialog'),
  /** A library record changed after the project opened: it has unsaved changes. */
  onLibraryChanged: subscribe('libraryChanged'),
  /** Files an import the user started couldn't take, with why (main's `importForUi`). */
  onImportSkipped: subscribe('importSkipped'),

  // Export
  exportProject: invoke('exportProject'),
  revealFile: invoke('revealFile'),

  // Settings
  getSettings: invoke('getSettings'),
  updateSettings: invoke('updateSettings'),
  chooseExportDir: invoke('chooseExportDir'),

  // Captions and audio
  whisperAvailable: invoke('whisperAvailable'),
  transcribeMedia: invoke('transcribeMedia'),
  getTranscript: invoke('getTranscript'),
  detectSilence: invoke('detectSilence'),
  getLoudness: invoke('getLoudness'),
  renderAudioFx: invoke('renderAudioFx'),

  // Background removal and jobs
  segmentAvailable: invoke('segmentAvailable'),
  removeBackground: invoke('removeBackground'),
  poseAvailable: invoke('poseAvailable'),
  detectPose: invoke('detectPose'),
  getPose: invoke('getPose'),
  cancelJob: invoke('cancelJob'),
  /** Subscribe to background job progress. Returns an unsubscribe function. */
  onJobProgress: subscribe('jobProgress'),

  // Stills
  captureStillToLibrary: invoke('captureStillToLibrary'),
  captureStillToDisk: invoke('captureStillToDisk'),

  // AI assistant: main asks the renderer to run store ops; the renderer answers.
  onAssistantRequest: subscribe('assistantRequest'),
  assistantRespond: send('assistantResponse'),
  assistantStatus: invoke('assistantStatus')
}

export type RendererApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // Non-isolated fallback: define it on the page's global (`window`). Written
  // against `globalThis` because this file is checked by both tsconfigs and
  // only the web one has the DOM lib (index.d.ts types it for the renderer).
  Object.assign(globalThis, { api })
}
