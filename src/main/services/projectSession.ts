/**
 * Everything main keeps for the open project, in ONE object that lives exactly
 * as long as the project is open: the folder, the in-memory library, the
 * single-flight maps and the failure memory of the media, loudness and
 * transcription jobs, and the id of the document the renderer has open.
 *
 * Opening, creating or switching to a project makes a new session and disposes
 * the old one, so none of that state can survive a switch or answer for the
 * wrong project (media ids are content fingerprints: the same file has the
 * same id in every project that uses it). Save As keeps the session and moves
 * its root. There may be no session: the app starts on a start screen.
 *
 * Services reach the open project through `requireSession` / `currentSession`.
 * A long job (export, matte, transcribe, quick cut, merge, import) takes the
 * session once at its start and passes it on, so a switch mid-job lets it
 * finish in the project it started in; the disposed session refuses to
 * record anything new in its library.
 *
 * No Electron here: a session is constructible in a unit test.
 */

import type { MediaAsset } from '@shared/media'
import type { LoudnessSeries } from '@shared/loudness'
import type { Transcript } from '@shared/transcript'
import { singleFlight } from './atomicWrite'
import { Library } from './library'

export class ProjectSession {
  /** The project folder (moves on Save As). */
  root: string
  /** Set when the project is closed or replaced; a job that still holds the session sees it. */
  disposed = false
  readonly library: Library
  /** Id of the document open in the renderer — autosaves for any other are stale. */
  openId: string | null = null

  // Media store (mediaStore.ts). Keys that are cache paths already include the
  // root; the import flight is keyed by media id, which is why it lives here.
  readonly proxyFlight = singleFlight<void>() // by cache path of the proxy
  readonly artifactFlight = singleFlight<void>() // by output path
  readonly importFlight = singleFlight<MediaAsset>() // by media id
  /** Derived files / proxies whose generator failed (by output path / cache dir):
   *  the library load runs on every refetch and must not retry — and log — a
   *  file that can't be made. Reopening the project retries. */
  readonly artifactFailed = new Set<string>()
  readonly proxyFailed = new Set<string>()

  // Loudness series (loudness.ts), by output path.
  readonly loudnessFlight = singleFlight<LoudnessSeries | null>()
  readonly loudnessFailed = new Set<string>()
  /** Series whose pass is running — its ffmpeg has the original open. */
  readonly loudnessReading = new Set<string>()

  // Transcription (whisper.ts), by media id.
  readonly transcribeFlight = singleFlight<Transcript>()

  constructor(root: string) {
    this.root = root
    this.library = new Library(this)
  }

  /** Whether this is the session of the project that is open now. */
  get isCurrent(): boolean {
    return current === this
  }

  /** Save As moved the project: relative paths are measured from `newRoot`. */
  reroot(newRoot: string, resolve: (root: string, rel: string) => string): void {
    this.library.rebase(newRoot, resolve)
    this.root = newRoot
  }
}

let current: ProjectSession | null = null

/** Start the session of a newly opened / created project, disposing the previous one. */
export function openSession(root: string): ProjectSession {
  if (current) current.disposed = true
  current = new ProjectSession(root)
  return current
}

/** No project is open any more (a failed launch). */
export function closeSession(): void {
  if (current) current.disposed = true
  current = null
}

/** The open project's session, or null when none is open. */
export function currentSession(): ProjectSession | null {
  return current
}

/** The open project's session; throws when none is open. */
export function requireSession(): ProjectSession {
  if (!current) throw new Error('No project is open.')
  return current
}
