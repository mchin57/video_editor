/**
 * Re-probe, while a project opens, the library records whose saved probe is
 * stale (`needsReprobe`). Today that is images probed before the probe read
 * EXIF orientation: a portrait iPhone photo saved as landscape, which squashed
 * its layer box, thumb and export (docs/FFMPEG-NOTES.md "EXIF orientation").
 */

import { promises as fsp } from 'node:fs'
import { probeFile } from './ffprobe'
import { needsReprobe } from './ffprobeParse'
import type { ProjectSession } from './projectSession'
import { cachePath } from './projectLayout'

/**
 * Only the probe changes: id, fingerprint and paths stay, so the timeline's
 * references hold. A record whose picture changed shape loses its cached thumb
 * (built at the old size; the library load rebuilds it) and makes the project
 * dirty — the return value, like a path fixed on open; Save writes it. One that
 * only gained the version marker is updated in memory without making the
 * project dirty (the next save carries it). A missing original keeps its old
 * probe until a later open finds it. Call after `resolveAll` (it needs the
 * found paths).
 */
export async function reprobeStale(session: ProjectSession): Promise<boolean> {
  const { root, library } = session
  let changed = false
  for (const { record, path } of library.allEntries()) {
    if (!path || !needsReprobe(record)) continue
    const probe = await probeFile(path).catch(() => null)
    if (!probe) continue
    const was = record.probe.video
    const now = probe.video
    if (was?.displayWidth !== now?.displayWidth || was?.displayHeight !== now?.displayHeight) {
      await fsp.rm(cachePath(root, record.id, 'thumb.jpg'), { force: true })
      changed = true
    }
    library.patchOpeningRecord(record.id, { probe })
  }
  return changed
}
