import type { MediaAsset } from '@shared/media'
import { expandImportPaths } from './importScan'
import { ensureProxy, importFile } from './mediaStore'

export interface ImportReport {
  assets: MediaAsset[]
  /** Files that failed to import, with why (e.g. missing, or not media ffprobe can read). */
  skipped: { path: string; reason: string }[]
}

/**
 * Import each path (fast hash+probe), then kick proxy generation in the
 * background. Any directory in `paths` is expanded to the media files inside it
 * first, so a picked or dropped FOLDER imports its contents. A file that fails
 * is reported in `skipped` rather than sinking the rest.
 */
export async function importManyReport(paths: string[]): Promise<ImportReport> {
  const report: ImportReport = { assets: [], skipped: [] }
  for (const path of await expandImportPaths(paths)) {
    try {
      const asset = await importFile(path)
      report.assets.push(asset)
      if (!asset.proxyReady) {
        void ensureProxy(asset.id).catch((err) => console.error('proxy generation failed', err))
      }
    } catch (err) {
      console.error('import failed for', path, err)
      report.skipped.push({ path, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}

/** `importManyReport` for the UI paths, which only need what was imported. */
export async function importMany(paths: string[]): Promise<MediaAsset[]> {
  return (await importManyReport(paths)).assets
}
