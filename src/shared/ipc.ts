/** IPC channel names shared between main (handlers) and preload (invokers). */

export const IPC = {
  getCapabilities: 'system:getCapabilities',
  getDataDir: 'system:getDataDir',
  // Media library (M1)
  importDialog: 'media:importDialog',
  importPaths: 'media:importPaths',
  listLibrary: 'media:list',
  ensureProxy: 'media:ensureProxy',
  removeMedia: 'media:remove',
  // Project (M2)
  loadProject: 'project:load',
  saveProject: 'project:save',
  // Export (M3)
  exportProject: 'export:run',
  revealFile: 'shell:reveal',
  // Settings
  getSettings: 'settings:get',
  chooseExportDir: 'settings:chooseExportDir',
  // Captions (M4)
  whisperAvailable: 'whisper:available',
  transcribeMedia: 'whisper:transcribe',
  getTranscript: 'whisper:getTranscript'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer-visible event channels (main → renderer pushes). */
export const IPC_EVENT = {
  jobProgress: 'job:progress'
} as const
