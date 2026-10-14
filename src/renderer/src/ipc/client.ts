/**
 * Renderer access to the main process. The call wrappers are destructured
 * straight off the typed preload surface (`window.api`, typed as `RendererApi`
 * in src/preload/index.d.ts), so there is no second hand-maintained list of
 * signatures to keep in sync — the preload's `api` object is the single source
 * of truth. (Safe to detach: every preload method is a closure that doesn't use
 * `this`.) The `reelmedia://` URL builders below are the only IPC-adjacent logic
 * the renderer itself owns. @see docs/SHARED.md
 */

import type { MediaAsset } from '@shared/media'

export const {
  getCapabilities,
  getDataDir,
  importDialog,
  importPaths,
  importFolderDialog,
  extractAudioDialog,
  listProjectMedia,
  ensureProxy,
  relinkMediaDialog,
  quickCut,
  setMediaDescription,
  renameMedia,
  loadProject,
  saveProject,
  openProjectFile,
  saveProjectAs,
  saveProjectFile,
  createProject,
  chooseProjectLocation,
  defaultProjectLocation,
  getProjectDir,
  convertLegacyFolderDialog,
  exportProject,
  revealFile,
  getSettings,
  updateSettings,
  chooseExportDir,
  whisperAvailable,
  transcribeMedia,
  getTranscript,
  detectSilence,
  getLoudness,
  segmentAvailable,
  removeBackground,
  cancelJob,
  renderAudioFx,
  captureStillToLibrary,
  captureStillToDisk,
  pathForFile,
  onJobProgress,
  onLibraryChanged,
  onAssistantRequest,
  assistantRespond,
  assistantStatus
} = window.api

/** What a media URL needs: the asset's id and its content revision. An
 *  asset (`MediaAsset`) is one; a bare `{ id }` works but never reloads after
 *  the content changes. */
export type MediaRef = { id: string; rev?: string }

/** `reelmedia://<id>/<file>?v=<rev>`. The protocol reads only the host and
 *  path; the revision exists so a clip relinked to DIFFERENT content ("Update
 *  path anyway") gets new addresses — same id and file names otherwise, so
 *  <video>, <audio> and <img> would keep showing the old proxy. */
const mediaUrl = (m: MediaRef, file: string): string =>
  `reelmedia://${m.id}/${file}${m.rev ? `?v=${m.rev}` : ''}`

/** Stream URL for a media asset's proxy via the reelmedia:// scheme. */
export const proxyUrl = (m: MediaRef): string => mediaUrl(m, 'proxy.mp4')

/** Stream URL for a background-removed clip's alpha-preserving VP9 WebM proxy. */
export const alphaProxyUrl = (m: MediaRef): string => mediaUrl(m, 'proxy.webm')

/** The playable video-proxy URL for an asset: the alpha WebM for background-removed
 *  clips (so <video> keeps transparency), else the H.264 mp4. */
export const videoProxyUrl = (asset: MediaAsset): string =>
  asset.probe.video?.hasAlpha ? alphaProxyUrl(asset) : proxyUrl(asset)

/** URL for a media asset's first-frame thumbnail. */
export const thumbUrl = (m: MediaRef): string => mediaUrl(m, 'thumb.jpg')

/** URL for an image asset's full display PNG (alpha preserved) — for overlays. */
export const imageUrl = (m: MediaRef): string => mediaUrl(m, 'image.png')

/** Stream URL for an audio-only asset's AAC proxy (music bed). */
export const audioUrl = (m: MediaRef): string => mediaUrl(m, 'audio.m4a')

/** URL for an audio asset's waveform image. */
export const waveformUrl = (m: MediaRef): string => mediaUrl(m, 'waveform.png')

/** URL for a bundled font file (resources/fonts/<file>) for `@font-face`. */
export const fontUrl = (file: string): string => `reelmedia://fonts/${file}`

/** A rejected IPC call's own message, without Electron's wrapper
 *  ("Error invoking remote method 'media:rename': Error: …"), for showing to
 *  the user inline. */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}
