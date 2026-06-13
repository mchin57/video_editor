/** IPC channel names shared between main (handlers) and preload (invokers). */

export const IPC = {
  getCapabilities: 'system:getCapabilities',
  getDataDir: 'system:getDataDir'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer-visible event channels (main → renderer pushes). */
export const IPC_EVENT = {
  jobProgress: 'job:progress'
} as const
