/**
 * The message that blocks a job or an export when media can't be used — pure.
 * A library item is usable when its original was found (docs/MEDIA-POINTERS.md
 * "Checking on open"); the media store locates it and calls this with the
 * answer.
 */

import type { MediaStatus } from '@shared/media'

/** The message that blocks an export / job, naming every missing file. */
export function unusableMessage(items: { fileName: string; status: MediaStatus }[]): string {
  const missing = items.filter((i) => i.status !== 'ok').map((i) => i.fileName)
  return `Some media can't be used (missing: ${missing.join(', ')}). Use Relink… on each one in the Library to find it.`
}
