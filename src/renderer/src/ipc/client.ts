import type { FfmpegCapabilities } from '@shared/ffmpeg'
import type { MediaAsset } from '@shared/media'
import type { JobProgressEvent } from '@shared/jobs'
import type { Project } from '@shared/project'
import type { PresetId } from '@shared/export'
import type { Settings } from '@shared/settings'
import type { Transcript } from '@shared/transcript'

/** Thin typed wrappers over the preload-exposed window.api. */
export const getCapabilities = (): Promise<FfmpegCapabilities> => window.api.getCapabilities()
export const getDataDir = (): Promise<string> => window.api.getDataDir()

export const importDialog = (): Promise<MediaAsset[]> => window.api.importDialog()
export const importPaths = (paths: string[]): Promise<MediaAsset[]> => window.api.importPaths(paths)
/** Pick a video file and extract its audio into the library. null = canceled. */
export const extractAudioDialog = (): Promise<MediaAsset | null> => window.api.extractAudioDialog()
/** The current project's library: asset records for the given media ids. */
export const listProjectMedia = (ids: string[]): Promise<MediaAsset[]> =>
  window.api.listProjectMedia(ids)
export const ensureProxy = (id: string): Promise<void> => window.api.ensureProxy(id)

export const loadProject = (): Promise<Project> => window.api.loadProject()
export const saveProject = (project: Project): Promise<void> => window.api.saveProject(project)

/** Open a portable .reel file via a native dialog. null = canceled. */
export const openProjectFile = (): Promise<{ path: string; project: Project } | null> =>
  window.api.openProjectFile()
/** Save As… via a native dialog. Returns the chosen path + saved doc, or null. */
export const saveProjectAs = (project: Project): Promise<{ path: string; project: Project } | null> =>
  window.api.saveProjectAs(project)
/** Save to an already-bound path (no dialog). */
export const writeProjectFile = (project: Project, path: string): Promise<Project> =>
  window.api.writeProjectFile(project, path)

export const exportProject = (
  project: Project,
  opts: { preset: PresetId; preferNvenc: boolean }
): Promise<string | null> => window.api.exportProject(project, opts)
export const revealFile = (path: string): Promise<boolean> => window.api.revealFile(path)

export const getSettings = (): Promise<Settings> => window.api.getSettings()
export const updateSettings = (patch: Partial<Settings>): Promise<Settings> =>
  window.api.updateSettings(patch)
export const chooseExportDir = (): Promise<Settings> => window.api.chooseExportDir()

export const whisperAvailable = (): Promise<boolean> => window.api.whisperAvailable()
export const transcribeMedia = (mediaId: string): Promise<Transcript> =>
  window.api.transcribeMedia(mediaId)
export const getTranscript = (mediaId: string): Promise<Transcript | null> =>
  window.api.getTranscript(mediaId)
export const detectSilence = (mediaId: string): Promise<{ start: number; end: number }[]> =>
  window.api.detectSilence(mediaId)
export const pathForFile = (file: File): string => window.api.pathForFile(file)
export const onJobProgress = (cb: (ev: JobProgressEvent) => void): (() => void) =>
  window.api.onJobProgress(cb)

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
