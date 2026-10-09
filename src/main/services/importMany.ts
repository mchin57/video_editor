import type { MediaAsset } from '@shared/media'
import { expandImportPaths } from './importScan'
import { ensureProxy, importFile } from './mediaStore'

/**
 * Import each path (fast hash+probe), then kick proxy generation in the
 * background. Any directory in `paths` is expanded to the media files inside it
 * first, so a picked or dropped FOLDER imports its contents.
 */
export async function importMany(paths: string[]): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = []
  for (const path of await expandImportPaths(paths)) {
    try {
      const asset = await importFile(path)
      assets.push(asset)
      if (!asset.proxyReady) {
        void ensureProxy(asset.id).catch((err) => console.error('proxy generation failed', err))
      }
    } catch (err) {
      console.error('import failed for', path, err)
    }
  }
  return assets
}
