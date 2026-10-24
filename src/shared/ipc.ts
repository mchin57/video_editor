/**
 * IPC between main and the renderer: channel names (`IPC`, `IPC_EVENT`), the
 * request/response shapes, and the contract (`IpcInvoke`, `IpcSend`,
 * `IpcEvents`, at the bottom) that both sides are typed against. Adding a
 * call: a contract entry + its channel name here, its argument schema in
 * `main/ipc/schemas.ts`, its handler in `main/ipc/`, and its name in the
 * renderer's `ipc/client.ts` destructure. The preload needs one line.
 */

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
  relinkMediaDialog: 'media:relinkDialog',
  renameMedia: 'media:rename',
  quickCut: 'media:quickCut',
  mergeClips: 'media:merge',
  setMediaDescription: 'media:setDescription',
  // Project (M2) — a project is a folder (docs/MEDIA-POINTERS.md).
  // loadProject/saveProject read and write the working copy (autosave.json:
  // crash recovery + restore on launch); the File ▸ actions below create,
  // open and save the folder's <Name>.reel.
  loadProject: 'project:load',
  saveProject: 'project:save',
  openProjectFile: 'project:openFile',
  saveProjectAs: 'project:saveAs',
  saveProjectFile: 'project:saveFile',
  createProject: 'project:create',
  chooseProjectLocation: 'project:chooseLocation',
  defaultProjectLocation: 'project:defaultLocation',
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
  getLoudness: 'audio:getLoudness',
  // Background removal (subject-aware crop)
  segmentAvailable: 'segment:available',
  removeBackground: 'segment:removeBackground',
  // Body pose (detect once per media item, drawn on clips)
  poseAvailable: 'pose:available',
  detectPose: 'pose:detect',
  getPose: 'pose:get',
  // Background jobs
  cancelJob: 'job:cancel',
  // Stills (capture a frame from a clip)
  captureStillToLibrary: 'still:toLibrary',
  captureStillToDisk: 'still:toDisk',
  // AI assistant: main ⇄ renderer bridge + status for Settings
  assistantResponse: 'assistant:response',
  assistantStatus: 'assistant:status'
} as const satisfies Record<InvokeName | keyof IpcSend, string>

/** Payload describing which frame to grab and how to correct it. */
export interface StillRequest {
  mediaId: string
  /** Source-media time (seconds) of the frame to capture. */
  sourceSec: number
  /** Source-pixel crop to apply (null = full frame). */
  crop: { x: number; y: number; w: number; h: number } | null
  /** Color correction to apply (null = none). */
  color: { brightness: number; contrast: number; saturation: number } | null
  /** Tint to apply after the color correction (absent/null = none). */
  tint?: import('./tint').Tint | null
  /** Mirror the (cropped) picture, like the clip does on screen. Layer rotation
   *  is a transform like position, so a still does not bake it in. */
  flipH?: boolean
  flipV?: boolean
}

/** Library ▸ Quick cut…: cut a video into one new library clip per piece
 *  (`shared/quickCut.ts`). Pieces are source windows, sorted, non-overlapping. */
export interface QuickCutRequest {
  mediaId: string
  pieces: import('./quickCut').CutPiece[]
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

/** Whether pose detection can run: both models found and onnxruntime loads.
 *  `missing` names the model files still to install (the Inspector says so). */
export interface PoseAvailability {
  ready: boolean
  missing: string[]
  /** The folder to put user-installed models in (`<data>/bin/models`). */
  modelsDir: string
}

export interface DetectPoseRequest {
  mediaId: string
  /** Source window to cover, in the source's own time. Grown to include any
   *  window already detected for the same media, so other clips keep theirs. */
  startSec: number
  durationSec: number
  /** Slowest speed the clip plays the window at (1 = none): slow-mo is
   *  sampled more densely so the skeleton keeps up with fast limbs. */
  minSpeed: number
  /** Opaque tag echoed as the job's `subjectId` (the renderer passes the layer id). */
  subjectId?: string
}

/** A project as opened: the document, its `.reel` path, and whether it
 *  carries unsaved changes (an autosave, or library paths fixed on open). */
export interface LoadedProject {
  project: import('./project').Project
  path: string
  dirty: boolean
}

/** A Relink that went through (docs/MEDIA-POINTERS.md "Relink"). */
export interface RelinkResult {
  asset: import('./media').MediaAsset
  /** The clip was pointed at a file of a different length ("Update path
   *  anyway"): the renderer resets every placement to the whole new file. */
  cutsReset: boolean
  /** Other missing clips found in the same folder and reconnected (file names). */
  alsoFound: string[]
}

/** What the app opens to: the last project, or none (the start screen) with
 *  an optional reason to show there. */
export interface LaunchState {
  loaded: LoadedProject | null
  message: string | null
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer-visible event channels (main → renderer pushes). */
export const IPC_EVENT = {
  jobProgress: 'job:progress',
  /** A library record changed after the project opened (import, relink, a
   *  path fixed by a re-check): the project now has unsaved changes. */
  libraryChanged: 'library:changed',
  /** An import the user started had files that failed (`ImportSkip[]`): the
   *  renderer shows which and why. */
  importSkipped: 'media:importSkipped',
  assistantRequest: 'assistant:request'
} as const satisfies Record<keyof IpcEvents, string>

// ---------------------------------------------------------------------------
// The contract. Each invoke channel's arguments and result, declared ONCE:
// the preload builds `window.api` from it (`invoke('importPaths')`) and main
// registers handlers against it (`handle('importPaths', …)`), so a signature
// can't drift between the two sides. Main also checks the arguments at
// runtime (`main/ipc/schemas.ts`, typed against this) before a handler runs.
// ---------------------------------------------------------------------------

/** Options for an export from the Export button. */
export interface ExportOptions {
  preset: import('./formats').PresetId
  preferNvenc: boolean
}

type Fn<A extends unknown[], R> = { args: A; result: R }
type MediaAsset = import('./media').MediaAsset
type Project = import('./project').Project
type Settings = import('./settings').Settings
type Transcript = import('./transcript').Transcript

export interface IpcInvoke {
  getCapabilities: Fn<[], import('./ffmpeg').FfmpegCapabilities>
  getDataDir: Fn<[], string>

  // Media library
  importDialog: Fn<[], MediaAsset[]>
  importPaths: Fn<[paths: string[]], MediaAsset[]>
  importFolderDialog: Fn<[], MediaAsset[]>
  extractAudioDialog: Fn<[], MediaAsset | null>
  listProjectMedia: Fn<[ids: string[]], MediaAsset[]>
  ensureProxy: Fn<[id: string], void>
  /** Pick a file holding a missing asset's original (null = canceled). */
  relinkMediaDialog: Fn<[id: string], RelinkResult | null>
  /** Library Rename: the original on disk and the item get `stem` + the file's
   *  own extension (rejects with a reason; nothing changes then). */
  renameMedia: Fn<[id: string, stem: string], MediaAsset>
  /** Library Quick cut: one new clip in `generated/` per piece, in order (the
   *  original is untouched). Rejects with a reason before any encode. */
  quickCut: Fn<[req: QuickCutRequest], MediaAsset[]>
  /** Merge clips: ONE new clip in `generated/` joining the segments in order
   *  (the sources are untouched). Rejects with a reason before any encode. */
  mergeClips: Fn<[segments: import('./merge').MergeSegment[]], MediaAsset>
  /** A library item's description ('' clears); an unsaved change until Save. */
  setMediaDescription: Fn<[id: string, text: string], void>

  // Project — a project is a folder (docs/MEDIA-POINTERS.md). loadProject /
  // saveProject read and write its working copy (autosave); the *File* calls
  // create, open and save it.
  /** What to open at launch: the last project, or none (start screen). */
  loadProject: Fn<[], LaunchState>
  saveProject: Fn<[project: Project], void>
  openProjectFile: Fn<[], LoadedProject | null>
  saveProjectAs: Fn<[project: Project], { path: string; project: Project } | null>
  saveProjectFile: Fn<[project: Project], Project>
  /** File ▸ New: create `<location>/<name>/` and open it (rejects with a reason). */
  createProject: Fn<[name: string, location: string], LoadedProject>
  /** The New window's "Choose location…" folder picker (null = canceled). */
  chooseProjectLocation: Fn<[current: string], string | null>
  /** Where the New window starts: the Settings export folder. */
  defaultProjectLocation: Fn<[], string>
  /** The open project's folder (null when none is open). */
  getProjectDir: Fn<[], string | null>
  /** File ▸ Convert old projects…: summary lines, or null if canceled. */
  convertLegacyFolderDialog: Fn<[], string[] | null>

  // Export — the output path, or null if the Save dialog was canceled.
  exportProject: Fn<[project: Project, opts: ExportOptions], string | null>
  revealFile: Fn<[path: string], boolean>

  // Settings
  getSettings: Fn<[], Settings>
  updateSettings: Fn<[patch: Partial<Settings>], Settings>
  chooseExportDir: Fn<[], Settings>

  // Captions and audio analysis
  whisperAvailable: Fn<[], boolean>
  transcribeMedia: Fn<[mediaId: string], Transcript>
  getTranscript: Fn<[mediaId: string], Transcript | null>
  detectSilence: Fn<[mediaId: string], { start: number; end: number }[]>
  /** The asset's loudness series (measured first if not cached yet); null = no
   *  audio, original missing, or the measurement failed. */
  getLoudness: Fn<[mediaId: string], import('./loudness').LoudnessSeries | null>
  renderAudioFx: Fn<[req: AudioFxRequest], MediaAsset>

  // Background removal — matte one clip segment into a new transparent library
  // asset (a VP9 WebM with the segment's audio), gated on the segmentation
  // model being present. Resolves null when the job was canceled.
  segmentAvailable: Fn<[], boolean>
  removeBackground: Fn<[req: RemoveBackgroundRequest], MediaAsset | null>

  // Body pose — detect people's keypoints over a clip's source window (once
  // per media item, saved in the project folder) and read them back. Gated
  // on both pose models being installed. detectPose resolves null when the
  // job was canceled.
  poseAvailable: Fn<[], PoseAvailability>
  detectPose: Fn<[req: DetectPoseRequest], import('./pose').PoseData | null>
  getPose: Fn<[mediaId: string], import('./pose').PoseData | null>
  /** Ask a cancelable background job to stop (false = nothing to cancel). */
  cancelJob: Fn<[jobId: string], boolean>

  // Stills — capture a frame from a clip into the library, or save it to disk.
  captureStillToLibrary: Fn<[req: StillRequest], MediaAsset>
  captureStillToDisk: Fn<[req: StillRequest, suggestedName: string], string | null>

  /** The AI assistant's pipe server status, for Settings. */
  assistantStatus: Fn<[], import('./assistant/protocol').AssistantStatus>
}

/** One-way renderer → main messages (`ipcRenderer.send`). */
export interface IpcSend {
  /** The renderer's answer to an `assistantRequest`. */
  assistantResponse: [res: import('./assistant/protocol').AssistantResponse]
}

/** Main → renderer pushes, by `IPC_EVENT` key: the payload each carries. */
export interface IpcEvents {
  jobProgress: [ev: import('./jobs').JobProgressEvent]
  libraryChanged: []
  importSkipped: [skipped: import('./media').ImportSkip[]]
  assistantRequest: [req: import('./assistant/protocol').AssistantRequest]
}

export type InvokeName = keyof IpcInvoke
export type InvokeArgs<K extends InvokeName> = IpcInvoke[K]['args']
export type InvokeResult<K extends InvokeName> = IpcInvoke[K]['result']
