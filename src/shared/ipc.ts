/** IPC channel names shared between main (handlers) and preload (invokers). */

export const IPC = {
  getCapabilities: 'system:getCapabilities',
  getDataDir: 'system:getDataDir',
  // Media library (M1)
  importDialog: 'media:importDialog',
  importPaths: 'media:importPaths',
  listProjectMedia: 'media:listForProject',
  ensureProxy: 'media:ensureProxy',
  // Project (M2)
  // loadProject/saveProject persist the working copy (crash recovery + restore on
  // launch). The *File ▸* actions below read/write user-chosen portable .reel files.
  loadProject: 'project:load',
  saveProject: 'project:save',
  openProjectFile: 'project:openFile',
  saveProjectAs: 'project:saveAs',
  writeProjectFile: 'project:writeFile',
  // Export (M3)
  exportProject: 'export:run',
  revealFile: 'shell:reveal',
  // Settings
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  chooseExportDir: 'settings:chooseExportDir',
  // Captions (M4)
  whisperAvailable: 'whisper:available',
  transcribeMedia: 'whisper:transcribe',
  getTranscript: 'whisper:getTranscript',
  // Audio editing
  detectSilence: 'audio:detectSilence'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer-visible event channels (main → renderer pushes). */
export const IPC_EVENT = {
  jobProgress: 'job:progress'
} as const
