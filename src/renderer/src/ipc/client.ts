import type { FfmpegCapabilities } from '@shared/ffmpeg'

/** Thin typed wrappers over the preload-exposed window.api. */
export const getCapabilities = (): Promise<FfmpegCapabilities> => window.api.getCapabilities()
export const getDataDir = (): Promise<string> => window.api.getDataDir()
