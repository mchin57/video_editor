/**
 * Where an assistant-driven export goes (no Save dialog): a safe single file
 * name inside the export folder, never overwriting an existing file. Pure.
 */

import { join, parse } from 'node:path'
import type { Job } from '@shared/jobs'
import type { Project } from '@shared/project'

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** A model-supplied name → `<stem>.mp4` with no directory part, or null if nothing usable is left. */
export function sanitizeExportName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const stem = base
    .replace(/\.mp4$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
  if (!stem || /^\.+$/.test(stem)) return null
  return `${RESERVED.test(stem) ? `_${stem}` : stem}.mp4`
}

/** The first of `name`, `name (2)`, `name (3)`… in `dir` that `exists` reports free. */
export function uniqueExportPath(dir: string, name: string, exists: (path: string) => boolean): string {
  const { name: stem, ext } = parse(name)
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
    if (!exists(candidate)) return candidate
  }
}

/** Why an export must not start now, or null. Same "no clips" guard as the Export button. */
export function exportRefusal(
  project: Pick<Project, 'layers'>,
  jobs: Pick<Job, 'type' | 'status'>[]
): string | null {
  if (jobs.some((j) => j.type === 'export' && j.status === 'running')) {
    return 'An export is already running — wait for it to finish'
  }
  if (!project.layers.some((l) => l.content.kind === 'video')) return 'The timeline has no video clips to export'
  return null
}
