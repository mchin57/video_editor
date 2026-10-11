/**
 * The open project's library, held by main IN MEMORY (docs/MEDIA-POINTERS.md
 * "In memory until saved"). Records arrive from the `.reel` (or its autosave)
 * when a project opens, change on import / relink / path fixes, and reach disk
 * only through `projectStore` — the autosave mirrors them, and Save writes them
 * into the `.reel`. Nothing here touches the project folder.
 *
 * Each entry also carries where its original was last FOUND this session
 * (`path`, null = missing). Finding goes through `locateOriginal`: relative
 * path first, absolute second, each accepted only on a fingerprint match; the
 * side that didn't match is updated here, which makes the project dirty.
 */

import { promises as fsp } from 'node:fs'
import type { Fingerprint, MediaRecord } from '@shared/media'
import { fingerprintFile, sameFingerprint } from './fingerprint'
import { locateOriginal, toRelativePath } from './mediaRef'

export interface LibraryEntry {
  record: MediaRecord
  /** Where the original was found this session; null = missing. */
  path: string | null
}

let root: string | null = null
const entries = new Map<string, LibraryEntry>()
const listeners = new Set<() => void>()

/** Fingerprints by path + size + mtime: re-checking on every library refresh
 *  reads samples only for a file that changed since the last look. */
const fingerprintMemo = new Map<string, Fingerprint>()
async function memoFingerprint(path: string): Promise<Fingerprint> {
  const s = await fsp.stat(path)
  const key = `${path}|${s.size}|${s.mtimeMs}`
  let fp = fingerprintMemo.get(key)
  if (!fp) {
    fp = await fingerprintFile(path)
    fingerprintMemo.set(key, fp)
  }
  return fp
}

/** Fingerprint a file through the same memo the checks use. */
export const fingerprintOf = memoFingerprint

/** Replace the library with a newly opened project's records (paths unchecked). */
export function openLibrary(projectRoot: string, records: MediaRecord[]): void {
  root = projectRoot
  entries.clear()
  for (const record of records) entries.set(record.id, { record, path: null })
}

/** The folder relative paths are measured from (the open project's). */
export function libraryRoot(): string {
  if (!root) throw new Error('No project is open.')
  return root
}

/** Notified whenever a record changes after the project opened (import,
 *  relink, a path fixed by a later check): the renderer marks itself dirty. */
export function onLibraryChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const notify = (): void => listeners.forEach((l) => l())

export function getEntry(id: string): LibraryEntry | null {
  return entries.get(id) ?? null
}

/** Every entry (e.g. to look for the other missing clips after a relink). */
export function allEntries(): LibraryEntry[] {
  return [...entries.values()]
}

/** The entry already holding this content, if any (import dedup / auto-relink). */
export function findByFingerprint(fp: Fingerprint): LibraryEntry | null {
  for (const entry of entries.values()) if (sameFingerprint(entry.record.fingerprint, fp)) return entry
  return null
}

/** Add or replace a record, found at `path`. */
export function putEntry(record: MediaRecord, path: string | null): LibraryEntry {
  const entry = { record, path }
  entries.set(record.id, entry)
  notify()
  return entry
}

/**
 * Check one entry's paths now and apply any path update. `silent` (used while
 * a project is opening, before the renderer adopts it) reports a change by the
 * return value instead of notifying.
 */
export async function resolveEntry(id: string, silent = false): Promise<{ entry: LibraryEntry; changed: boolean } | null> {
  const entry = entries.get(id)
  if (!entry || !root) return null
  const at = root
  const res = await locateOriginal(entry.record, at, memoFingerprint)
  if (root !== at || entries.get(id) !== entry) return { entry, changed: false } // project switched meanwhile
  entry.path = res.path
  const changed = Object.keys(res.update).length > 0
  if (changed) {
    entry.record = { ...entry.record, ...res.update }
    if (!silent) notify()
  }
  return { entry, changed }
}

/** Check every entry (on open). True if any record's paths were updated. */
export async function resolveAll(): Promise<boolean> {
  let changed = false
  for (const id of [...entries.keys()]) {
    const res = await resolveEntry(id, true)
    if (res?.changed) changed = true
  }
  return changed
}

/**
 * The records to save with a document: those its JSON mentions anywhere
 * (library list, layers, nested comps, audio-fx provenance) — the same
 * generous rule as the cache sweep. Records only undo could bring back stay in
 * memory; a later save writes them again if they're back.
 */
export function recordsFor(docJson: string): MediaRecord[] {
  return [...entries.values()].map((e) => e.record).filter((r) => docJson.includes(`"${r.id}"`))
}

/**
 * Save As moved the project: measure every relative path from `newRoot`.
 * Generated media was copied along, so its absolute path moves too.
 */
export function rebaseLibrary(newRoot: string, generatedPathIn: (root: string, rel: string) => string): void {
  for (const entry of entries.values()) {
    const r = entry.record
    if (r.generated && r.relativePath) {
      const absolutePath = generatedPathIn(newRoot, r.relativePath)
      entry.record = { ...r, absolutePath }
      entry.path = absolutePath
    } else {
      entry.record = { ...r, relativePath: toRelativePath(newRoot, entry.path ?? r.absolutePath) }
    }
  }
  root = newRoot
}

/** Forget the open project (none is open). */
export function closeLibrary(): void {
  root = null
  entries.clear()
}
