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
  acceptChangedMedia: 'media:acceptChanged',
  relinkMediaDialog: 'media:relinkDialog',
  // Project (M2) — a project is a folder (docs/PROJECT-FOLDERS.md).
  // loadProject/saveProject read and write the working copy (autosave.json:
  // crash recovery + restore on launch); the File ▸ actions below open, save
  // and create the folder's <Name>.reel.
  loadProject: 'project:load',
  saveProject: 'project:save',
  openProjectFile: 'project:openFile',
  saveProjectAs: 'project:saveAs',
  saveProjectFile: 'project:saveFile',
  newProject: 'project:new',
  getProjectDir: 'project:getDir',
  convertLegacyFolderDialog: 'project:convertLegacyFolder',
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
  // Background jobs
  cancelJob: 'job:cancel',
  // Stills (capture a frame from a clip)
  captureStillToLibrary: 'still:toLibrary',
  captureStillToDisk: 'still:toDisk',
  // AI assistant: main ⇄ renderer bridge + status for Settings
  assistantResponse: 'assistant:response',
  assistantStatus: 'assistant:status'
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
  /** Mirror the (cropped) picture, like the clip does on screen. Layer rotation
   *  is a transform like position, so a still does not bake it in. */
  flipH?: boolean
  flipV?: boolean
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

/**
 * Matte ONE segment of a source clip — the source window a video layer actually
 * plays — into a new transparent library asset. The window is in the source's
 * own time; the result's t=0 is the source's `startSec`.
 */
export interface RemoveBackgroundRequest {
  mediaId: string
  /** Source window to matte, in the source's own time. */
  startSec: number
  durationSec: number
  /** Slowest playback speed the segment is played at (1 = none). Below 1 the
   *  matte keeps more of the source's frame rate so slow-mo stays smooth. */
  minSpeed: number
  /** Opaque tag echoed as the job's `subjectId` (the renderer passes the layer
   *  id, so the UI can find "the matte job for this layer"). */
  subjectId?: string
}

/** A project as opened: the document, its `.reel` path (null = the unsaved
 *  scratch project) and whether it carries unsaved changes (an autosave). */
export interface LoadedProject {
  project: import('./project').Project
  path: string | null
  dirty: boolean
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer-visible event channels (main → renderer pushes). */
export const IPC_EVENT = {
  jobProgress: 'job:progress',
  assistantRequest: 'assistant:request'
} as const
