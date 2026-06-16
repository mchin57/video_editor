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
export const listLibrary = (): Promise<MediaAsset[]> => window.api.listLibrary()
export const ensureProxy = (id: string): Promise<void> => window.api.ensureProxy(id)
export const removeMedia = (id: string): Promise<void> => window.api.removeMedia(id)

export const loadProject = (): Promise<Project> => window.api.loadProject()
export const saveProject = (project: Project): Promise<void> => window.api.saveProject(project)

export const exportProject = (
  project: Project,
  opts: { preset: PresetId; preferNvenc: boolean }
): Promise<string | null> => window.api.exportProject(project, opts)
export const revealFile = (path: string): Promise<boolean> => window.api.revealFile(path)

export const getSettings = (): Promise<Settings> => window.api.getSettings()
export const chooseExportDir = (): Promise<Settings> => window.api.chooseExportDir()

export const whisperAvailable = (): Promise<boolean> => window.api.whisperAvailable()
export const transcribeMedia = (mediaId: string): Promise<Transcript> =>
  window.api.transcribeMedia(mediaId)
export const getTranscript = (mediaId: string): Promise<Transcript | null> =>
  window.api.getTranscript(mediaId)
export const pathForFile = (file: File): string => window.api.pathForFile(file)
export const onJobProgress = (cb: (ev: JobProgressEvent) => void): (() => void) =>
  window.api.onJobProgress(cb)

/** Stream URL for a media asset's proxy via the reelmedia:// scheme. */
export const proxyUrl = (id: string): string => `reelmedia://${id}/proxy.mp4`

/** URL for a media asset's first-frame thumbnail. */
export const thumbUrl = (id: string): string => `reelmedia://${id}/thumb.jpg`

/** Stream URL for an audio-only asset's AAC proxy (music bed). */
export const audioUrl = (id: string): string => `reelmedia://${id}/audio.m4a`

/** URL for an audio asset's waveform image. */
export const waveformUrl = (id: string): string => `reelmedia://${id}/waveform.png`
