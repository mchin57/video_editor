/** IPC channel names shared between main (handlers) and preload (invokers). */

import type { AudioFxSettings } from './audioFx'

export const IPC = {
  getCapabilities: 'system:getCapabilities',
  getDataDir: 'system:getDataDir',
  // Media library (M1)
  importDialog: 'media:importDialog',
  importPaths: 'media:importPaths',
  importFolderDialog: 'media:importFolderDialog',
  extractAudioDialog: 'media:extractAudioDialog',
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
  detectSilence: 'audio:detectSilence',
  renderAudioFx: 'audio:renderFx',
  // Background removal (subject-aware crop)
  segmentAvailable: 'segment:available',
  removeBackground: 'segment:removeBackground',
  // Stills (capture a frame from a clip)
  captureStillToLibrary: 'still:toLibrary',
  captureStillToDisk: 'still:toDisk'
} as const

/** Payload describing which frame to grab and how to correct it. */
export interface StillRequest {
  mediaId: string
  /** Source-media time (seconds) of the frame to capture. */
  sourceSec: number
  /** Source-pixel crop to apply (null = full frame). */
  crop: { x: number; y: number; w: number; h: number } | null
  /** Color correction to apply (null = none). */
  color: { brightness: number; contrast: number; saturation: number } | null
}

/** Ask main to render an effect's wet signal into a new library asset. */
export interface AudioFxRequest {
  settings: AudioFxSettings
  /** Library asset the dry signal comes from. */
  sourceMediaId: string
  /** Source window to render, in the source's own time. */
  inSec: number
  outSec: number
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer-visible event channels (main → renderer pushes). */
export const IPC_EVENT = {
  jobProgress: 'job:progress'
} as const
