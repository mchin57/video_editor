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

import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import type { Fingerprint, MediaRecord } from '@shared/media'
import { fingerprintFile, sameFingerprint } from './fingerprint'
import { locateOriginal, toRelativePath } from './mediaRef'

export interface LibraryEntry {
  record: MediaRecord
  /** Where the original was found this session; null = missing. */
  path: string | null
  /** A forced relink gave this clip different content, so its transcript
   *  describes the old file. It is hidden now and deleted only on Save (not
   *  saving puts the old record — and transcript — back). */
  staleTranscript?: boolean
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

/**
 * Add or replace a record, found at `path`. `forRoot` is the project the
 * caller captured when it started: if another project opened meanwhile (an
 * import still running across File > Open), the write is refused rather than
 * landing in the wrong library.
 */
export function putEntry(record: MediaRecord, path: string | null, forRoot: string): LibraryEntry {
  if (root !== forRoot) throw new Error('The project changed while this media was being added.')
  const entry: LibraryEntry = { record, path, staleTranscript: entries.get(record.id)?.staleTranscript }
  entries.set(record.id, entry)
  notify()
  return entry
}

/**
 * An id for new content: `preferred` (the fingerprint's id) unless a record
 * holding DIFFERENT content already has it — a clip relinked with "Update path
 * anyway" keeps its old id — then a derived one.
 */
export function freeIdFor(preferred: string, fp: Fingerprint): string {
  let id = preferred
  for (let n = 1; ; n++) {
    const taken = entries.get(id)
    if (!taken || sameFingerprint(taken.record.fingerprint, fp)) return id
    id = createHash('sha1').update(`${preferred}:${n}`).digest('hex').slice(0, 12)
  }
}

/** Hide a clip's transcript until Save deletes it (see `staleTranscript`). */
export function markTranscriptStale(id: string): void {
  const entry = entries.get(id)
  if (entry) entry.staleTranscript = true
}

/** A new transcript was written for the clip's current content. */
export function clearStaleTranscript(id: string): void {
  const entry = entries.get(id)
  if (entry) entry.staleTranscript = false
}

/** Ids whose transcript is stale — Save deletes those files and clears them. */
export function staleTranscriptIds(): string[] {
  return [...entries.values()].filter((e) => e.staleTranscript).map((e) => e.record.id)
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
 * Generated media living in `generated/` was copied along, so its absolute
 * path moves too — when the copy is really there; anything else (footage, or
 * a generated record whose file was already gone) keeps its absolute path.
 */
export function rebaseLibrary(newRoot: string, resolve: (root: string, rel: string) => string): void {
  for (const entry of entries.values()) {
    const r = entry.record
    const copied =
      r.generated && r.relativePath?.toLowerCase().startsWith('generated/') ? resolve(newRoot, r.relativePath) : null
    if (copied && existsSync(copied)) {
      entry.record = { ...r, absolutePath: copied }
      entry.path = copied
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
