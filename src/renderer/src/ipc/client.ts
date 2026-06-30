/**
 * Renderer access to the main process. The call wrappers are destructured
 * straight off the typed preload surface (`window.api`, typed as `RendererApi`
 * in src/preload/index.d.ts), so there is no second hand-maintained list of
 * signatures to keep in sync — the preload's `api` object is the single source
 * of truth. (Safe to detach: every preload method is a closure that doesn't use
 * `this`.) The `reelmedia://` URL builders below are the only IPC-adjacent logic
 * the renderer itself owns. @see docs/SHARED.md
 */

export const {
  getCapabilities,
  getDataDir,
  importDialog,
  importPaths,
  extractAudioDialog,
  listProjectMedia,
  ensureProxy,
  loadProject,
  saveProject,
  openProjectFile,
  saveProjectAs,
  writeProjectFile,
  exportProject,
  revealFile,
  getSettings,
  updateSettings,
  chooseExportDir,
  whisperAvailable,
  transcribeMedia,
  getTranscript,
  detectSilence,
  captureStillToLibrary,
  captureStillToDisk,
  pathForFile,
  onJobProgress
} = window.api

/** Stream URL for a media asset's proxy via the reelmedia:// scheme. */
export const proxyUrl = (id: string): string => `reelmedia://${id}/proxy.mp4`

/** URL for a media asset's first-frame thumbnail. */
export const thumbUrl = (id: string): string => `reelmedia://${id}/thumb.jpg`

/** URL for an image asset's full display PNG (alpha preserved) — for overlays. */
export const imageUrl = (id: string): string => `reelmedia://${id}/image.png`

/** Stream URL for an audio-only asset's AAC proxy (music bed). */
export const audioUrl = (id: string): string => `reelmedia://${id}/audio.m4a`

/** URL for an audio asset's waveform image. */
export const waveformUrl = (id: string): string => `reelmedia://${id}/waveform.png`

/** URL for a bundled font file (resources/fonts/<file>) for `@font-face`. */
export const fontUrl = (file: string): string => `reelmedia://fonts/${file}`
