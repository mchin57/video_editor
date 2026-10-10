/**
 * Is a project's original still the file it imported? Pure decisions only —
 * the media store does the stat / hash I/O and acts on the answer.
 *
 * Why this exists: an original is usually a HARDLINK to the user's source, and
 * an in-place overwrite of the source (Explorer "Replace the file", `copy /y`,
 * a tool saving over the same name) rewrites the shared bytes — verified in
 * docs/PROJECT-FOLDERS.md. Nothing can prevent that, so the project detects
 * it: size + mtime are recorded at import and compared before use; only a
 * mismatch pays for a re-hash, which tells a touched-but-identical file from a
 * genuinely different one.
 */

import type { MediaStatus } from '@shared/media'

interface Stamp {
  size: number
  mtimeMs: number
}

/** First look, from a stat alone: fine, gone, or needs a re-hash to decide. */
export function statVerdict(recorded: Partial<Stamp>, now: Stamp | null): 'ok' | 'missing' | 'rehash' {
  if (!now) return 'missing'
  // A record without a stamp (written before detection existed) can't be
  // checked by stat — let the hash decide once, then it gets a stamp.
  if (recorded.size === undefined || recorded.mtimeMs === undefined) return 'rehash'
  return recorded.size === now.size && recorded.mtimeMs === now.mtimeMs ? 'ok' : 'rehash'
}

/** After a re-hash: identical bytes are fine (just re-stamp), anything else changed. */
export function hashVerdict(recordedHash: string, nowHash: string): 'restamp' | 'changed' {
  return recordedHash === nowHash ? 'restamp' : 'changed'
}

/** The message that blocks an export / job, naming every unusable file. */
export function unusableMessage(items: { fileName: string; status: MediaStatus }[]): string {
  const bad = items.filter((i) => i.status !== 'ok')
  const missing = bad.filter((i) => i.status === 'missing').map((i) => i.fileName)
  const changed = bad.filter((i) => i.status === 'changed').map((i) => i.fileName)
  const parts: string[] = []
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`)
  if (changed.length) parts.push(`changed outside the app: ${changed.join(', ')}`)
  return `Some media can't be used (${parts.join('; ')}). Fix them in the Library — re-import or Relink, or use the new file.`
}
