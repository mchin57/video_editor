/**
 * Finding a library item's original from its two paths (docs/MEDIA-POINTERS.md
 * "Checking on open"): the relative path first, the absolute path second, each
 * accepted only if the file there matches the recorded fingerprint. Whichever
 * matches, the other path is brought up to date — in memory; only Save writes.
 *
 * CONTRACT STUB — signatures are fixed; bodies land with their tests.
 */

import type { Fingerprint, MediaRecord } from '@shared/media'

export type RefSide = 'relative' | 'absolute'

/** What one candidate path held when checked: its fingerprint, or null when
 *  there is no readable file there. */
export interface PathCheck {
  path: string
  fingerprint: Fingerprint | null
}

export interface Resolution {
  /** The absolute path to read, or null when neither path matches (missing). */
  path: string | null
  /** Which side matched (relative wins when both do). */
  found: RefSide | null
  /** Only the fields that must change for the record to agree with `path`. */
  update: { relativePath?: string | null; absolutePath?: string }
}

type RefFields = Pick<MediaRecord, 'relativePath' | 'absolutePath' | 'fingerprint'>

/**
 * Relative path from `projectDir` to `absPath`, '/'-separated, or null when
 * none exists (another drive). Comparison follows the platform's path rules
 * (case-insensitive on Windows).
 */
export function toRelativePath(projectDir: string, absPath: string): string | null {
  void projectDir
  void absPath
  throw new Error('toRelativePath: not implemented')
}

/** The absolute path a stored relative path points at from `projectDir`. */
export function fromRelativePath(projectDir: string, relativePath: string): string {
  void projectDir
  void relativePath
  throw new Error('fromRelativePath: not implemented')
}

/**
 * The pure decision, given what each path held (null check = that side has no
 * path to try, e.g. no relative path recorded). See the table in the doc.
 */
export function decideResolution(
  record: RefFields,
  projectDir: string,
  relative: PathCheck | null,
  absolute: PathCheck | null
): Resolution {
  void record
  void projectDir
  void relative
  void absolute
  throw new Error('decideResolution: not implemented')
}

/**
 * Check a record's paths on disk and decide. Cheap: a stat per path, and the
 * samples are read only for a file whose size matches the fingerprint.
 */
export async function locateOriginal(record: RefFields, projectDir: string): Promise<Resolution> {
  void record
  void projectDir
  throw new Error('locateOriginal: not implemented')
}
