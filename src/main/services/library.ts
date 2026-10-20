/**
 * The open project's library, held by main IN MEMORY (docs/MEDIA-POINTERS.md
 * "In memory until saved"). Records arrive from the `.reel` (or its autosave)
 * when a project opens, change on import / relink / path fixes, and reach disk
 * only through `projectStore` — the autosave mirrors them, and Save writes them
 * into the `.reel`. Nothing here touches the project folder.
 *
 * One `Library` belongs to one `ProjectSession` (projectSession.ts): opening
 * another project makes a new library, so nothing here can leak across a
 * switch. Only the change listeners are module-level — the IPC layer registers
 * them once, for whichever project is open.
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

/** What a library needs to know of the session that owns it. */
export interface LibraryOwner {
  /** The project folder relative paths are measured from. */
  readonly root: string
  /** The project was closed or replaced: the library takes no more writes. */
  readonly disposed: boolean
}

const listeners = new Set<() => void>()

/** Notified whenever a record changes after the project opened (import,
 *  relink, a path fixed by a later check): the renderer marks itself dirty. */
export function onLibraryChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const notify = (): void => listeners.forEach((l) => l())

export class Library {
  private readonly entries = new Map<string, LibraryEntry>()
  /** Fingerprints by path + size + mtime: re-checking on every library refresh
   *  reads samples only for a file that changed since the last look. */
  private readonly fingerprintMemo = new Map<string, Fingerprint>()

  constructor(private readonly owner: LibraryOwner) {}

  /** Fingerprint a file through the memo the checks use. */
  async fingerprintOf(path: string): Promise<Fingerprint> {
    const st = await fsp.stat(path)
    const key = `${path}|${st.size}|${st.mtimeMs}`
    let fp = this.fingerprintMemo.get(key)
    if (!fp) {
      fp = await fingerprintFile(path)
      this.fingerprintMemo.set(key, fp)
    }
    return fp
  }

  /** Fill the library with a newly opened project's records (paths unchecked). */
  load(records: MediaRecord[]): void {
    this.entries.clear()
    for (const record of records) this.entries.set(record.id, { record, path: null })
  }

  /** Add records quietly while a project is opening (placeholders for clips the
   *  document uses but nothing describes — unknownMedia.ts). Existing ids win. */
  addOpeningRecords(records: MediaRecord[]): void {
    for (const record of records) if (!this.entries.has(record.id)) this.entries.set(record.id, { record, path: null })
  }

  /** Correct a record quietly while a project is opening (a stale probe —
   *  reprobe.ts): the opener reports the change, as `resolveAll` does. */
  patchOpeningRecord(id: string, patch: Partial<MediaRecord>): void {
    const entry = this.entries.get(id)
    if (entry) entry.record = { ...entry.record, ...patch }
  }

  getEntry(id: string): LibraryEntry | null {
    return this.entries.get(id) ?? null
  }

  /** Every entry (e.g. to look for the other missing clips after a relink). */
  allEntries(): LibraryEntry[] {
    return [...this.entries.values()]
  }

  /** The entry already holding this content, if any (import dedup / auto-relink). */
  findByFingerprint(fp: Fingerprint): LibraryEntry | null {
    for (const entry of this.entries.values()) if (sameFingerprint(entry.record.fingerprint, fp)) return entry
    return null
  }

  /**
   * Add or replace a record, found at `path`. `forRoot` is the project folder
   * the caller captured when it started: if the project was closed or moved
   * meanwhile (an import still running across File > Open or Save As), the
   * write is refused rather than landing in the wrong library.
   *
   * `quiet` skips the change notification, for a caller whose renderer marks
   * the change itself in order (Rename, which then saves at once: a
   * notification arriving after that save would mark it unsaved again).
   */
  putEntry(record: MediaRecord, path: string | null, forRoot: string, quiet = false): LibraryEntry {
    if (this.owner.disposed || this.owner.root !== forRoot) {
      throw new Error('The project changed while this media was being added.')
    }
    const entry: LibraryEntry = { record, path, staleTranscript: this.entries.get(record.id)?.staleTranscript }
    this.entries.set(record.id, entry)
    if (!quiet) notify()
    return entry
  }

  /**
   * An id for new content: `preferred` (the fingerprint's id) unless a record
   * holding DIFFERENT content already has it — a clip relinked with "Update path
   * anyway" keeps its old id — then a derived one.
   */
  freeIdFor(preferred: string, fp: Fingerprint): string {
    let id = preferred
    for (let n = 1; ; n++) {
      const taken = this.entries.get(id)
      if (!taken || sameFingerprint(taken.record.fingerprint, fp)) return id
      id = createHash('sha1').update(`${preferred}:${n}`).digest('hex').slice(0, 12)
    }
  }

  /** Hide a clip's transcript until Save deletes it (see `staleTranscript`). */
  markTranscriptStale(id: string): void {
    const entry = this.entries.get(id)
    if (entry) entry.staleTranscript = true
  }

  /** A new transcript was written for the clip's current content. */
  clearStaleTranscript(id: string): void {
    const entry = this.entries.get(id)
    if (entry) entry.staleTranscript = false
  }

  /** Ids whose transcript is stale — Save deletes those files and clears them. */
  staleTranscriptIds(): string[] {
    return [...this.entries.values()].filter((e) => e.staleTranscript).map((e) => e.record.id)
  }

  /**
   * Check one entry's paths now and apply any path update. `silent` (used while
   * a project is opening, before the renderer adopts it) reports a change by the
   * return value instead of notifying.
   */
  async resolveEntry(id: string, silent = false): Promise<{ entry: LibraryEntry; changed: boolean } | null> {
    const entry = this.entries.get(id)
    if (!entry) return null
    const at = this.owner.root
    const res = await locateOriginal(entry.record, at, (p) => this.fingerprintOf(p))
    // The project closed or moved, or the entry was replaced, meanwhile.
    if (this.owner.disposed || this.owner.root !== at || this.entries.get(id) !== entry) {
      return { entry, changed: false }
    }
    entry.path = res.path
    const changed = Object.keys(res.update).length > 0
    if (changed) {
      entry.record = { ...entry.record, ...res.update }
      if (!silent) notify()
    }
    return { entry, changed }
  }

  /** Check every entry (on open). True if any record's paths were updated. */
  async resolveAll(): Promise<boolean> {
    let changed = false
    for (const id of [...this.entries.keys()]) {
      const res = await this.resolveEntry(id, true)
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
  recordsFor(docJson: string): MediaRecord[] {
    return [...this.entries.values()].map((e) => e.record).filter((r) => docJson.includes(`"${r.id}"`))
  }

  /**
   * Save As moved the project: measure every relative path from `newRoot`.
   * Generated media living in `generated/` was copied along, so its absolute
   * path moves too — when the copy is really there; anything else (footage, or
   * a generated record whose file was already gone) keeps its absolute path.
   * Called by `ProjectSession.reroot`, which moves the session's root with it.
   */
  rebase(newRoot: string, resolve: (root: string, rel: string) => string): void {
    for (const entry of this.entries.values()) {
      const r = entry.record
      const copied =
        r.generated && r.relativePath?.toLowerCase().startsWith('generated/') ? resolve(newRoot, r.relativePath) : null
      if (copied && existsSync(copied)) {
        entry.record = { ...r, absolutePath: copied }
        entry.path = copied
      } else if (!entry.path && !r.absolutePath) {
        // An unknown clip: no path at all to re-measure.
      } else {
        entry.record = { ...r, relativePath: toRelativePath(newRoot, entry.path ?? r.absolutePath) }
      }
    }
  }
}
