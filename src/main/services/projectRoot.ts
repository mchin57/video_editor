/**
 * Which project folder is open. Main owns this (the media store, the
 * `reelmedia://` protocol, the exporter and the assistant all resolve paths
 * through it); `projectStore` sets it on launch / New / Open / Save As.
 * There may be none: the app launches to a start screen when there's no
 * project to reopen (docs/MEDIA-POINTERS.md).
 *
 * Long jobs capture the root once at their start, so a project switch mid-job
 * finishes the job in the folder it started in.
 */

let root: string | null = null

export function getProjectRoot(): string {
  if (!root) throw new Error('No project is open.')
  return root
}

/** The open project's folder, or null when none is open. */
export function currentProjectRoot(): string | null {
  return root
}

export function setProjectRoot(next: string | null): void {
  root = next
}
