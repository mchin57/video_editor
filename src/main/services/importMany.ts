import { stat } from 'node:fs/promises'
import type { ImportSkip, MediaAsset } from '@shared/media'
import { importFailureReason } from './importFailure'
import { expandImportPaths } from './importScan'
import { ensureProxy, importFile } from './mediaStore'
import { requireSession } from './projectSession'
import { createLogger } from '@shared/log'

const log = createLogger('import')

export interface ImportReport {
  assets: MediaAsset[]
  /** Files that failed to import, with why (e.g. missing, or not media ffprobe can read). */
  skipped: ImportSkip[]
}

/**
 * Import each path (fast hash+probe), then kick proxy generation in the
 * background. Any directory in `paths` is expanded to the media files inside it
 * first, so a picked or dropped FOLDER imports its contents. A file that fails
 * is reported in `skipped` rather than sinking the rest. Every import route
 * goes through here: the UI's (ipc.ts shows `skipped` in the import notice) and
 * the assistant's import_media (returns it).
 */
export async function importManyReport(paths: string[]): Promise<ImportReport> {
  const session = requireSession() // the whole batch lands in the project it started in
  const report: ImportReport = { assets: [], skipped: [] }
  for (const path of await expandImportPaths(paths)) {
    try {
      const asset = await importFile(path, undefined, session)
      report.assets.push(asset)
      if (!asset.proxyReady) {
        void ensureProxy(asset.id, session).catch((err) => log.error(`proxy generation failed for ${asset.id}`, err))
      }
    } catch (err) {
      log.error(`import failed for ${path}`, err)
      const size = await stat(path).then(
        (s) => s.size,
        () => undefined
      )
      report.skipped.push({ path, reason: importFailureReason(err, size) })
    }
  }
  return report
}
