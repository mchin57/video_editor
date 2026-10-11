/**
 * Finding a library item's original from its two paths (docs/MEDIA-POINTERS.md
 * "Checking on open"): the relative path first, the absolute path second, each
 * accepted only if the file there matches the recorded fingerprint. Whichever
 * matches, the other path is brought up to date — in memory; only Save writes.
 */

import path, { type PlatformPath } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Fingerprint, MediaRecord } from '@shared/media'
import { fingerprintFile, sameFingerprint } from './fingerprint'

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

/** {@link toRelativePath} under explicit path rules (tests pass `path.win32`). */
export function relativePathWith(p: PlatformPath, projectDir: string, absPath: string): string | null {
  const rel = p.relative(projectDir, absPath)
  // path.relative returns an absolute path when none exists (another drive or UNC share).
  if (p.isAbsolute(rel)) return null
  return rel.split(p.sep).join('/')
}

/** Whether two paths name the same file under `p`'s rules (case-insensitive on win32). */
export function samePath(a: string, b: string, p: PlatformPath = path): boolean {
  const na = p.normalize(a)
  const nb = p.normalize(b)
  return p.sep === '\\' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/**
 * Relative path from `projectDir` to `absPath`, '/'-separated, or null when
 * none exists (another drive). Comparison follows the platform's path rules
 * (case-insensitive on Windows).
 */
export function toRelativePath(projectDir: string, absPath: string): string | null {
  return relativePathWith(path, projectDir, absPath)
}

/** The absolute path a stored relative path points at from `projectDir`. */
export function fromRelativePath(projectDir: string, relativePath: string): string {
  return path.resolve(projectDir, ...relativePath.split('/'))
}

const matches = (check: PathCheck | null, fp: Fingerprint): check is PathCheck =>
  !!check?.fingerprint && sameFingerprint(check.fingerprint, fp)

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
  if (matches(relative, record.fingerprint)) {
    const update: Resolution['update'] = {}
    if (!samePath(record.absolutePath, relative.path)) update.absolutePath = relative.path
    return { path: relative.path, found: 'relative', update }
  }
  if (matches(absolute, record.fingerprint)) {
    const update: Resolution['update'] = {}
    const rel = toRelativePath(projectDir, absolute.path)
    const unchanged =
      rel === null || record.relativePath === null ? rel === record.relativePath : samePath(rel, record.relativePath)
    if (!unchanged) update.relativePath = rel
    return { path: absolute.path, found: 'absolute', update }
  }
  return { path: null, found: null, update: {} }
}

/** Stat first; read samples only for a regular file whose size matches. */
async function checkPath(
  p: string,
  fp: Fingerprint,
  readFingerprint: (path: string) => Promise<Fingerprint>
): Promise<PathCheck> {
  try {
    const st = await stat(p)
    if (!st.isFile() || st.size !== fp.size) return { path: p, fingerprint: null }
    return { path: p, fingerprint: await readFingerprint(p) }
  } catch {
    return { path: p, fingerprint: null }
  }
}

/**
 * Check a record's paths on disk and decide. Cheap: a stat per path, and the
 * samples are read only for a file whose size matches the fingerprint. The
 * library passes a memoized `readFingerprint` (it re-checks on every refresh).
 */
export async function locateOriginal(
  record: RefFields,
  projectDir: string,
  readFingerprint: (path: string) => Promise<Fingerprint> = fingerprintFile
): Promise<Resolution> {
  const relative =
    record.relativePath === null
      ? null
      : await checkPath(fromRelativePath(projectDir, record.relativePath), record.fingerprint, readFingerprint)
  // Relative wins outright, so the absolute side is only looked at when it lost.
  const absolute = matches(relative, record.fingerprint)
    ? null
    : await checkPath(record.absolutePath, record.fingerprint, readFingerprint)
  return decideResolution(record, projectDir, relative, absolute)
}
