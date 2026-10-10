/**
 * Which project folder is open. Main owns this (the media store, the
 * `reelmedia://` protocol, the exporter and the assistant all resolve paths
 * through it); `projectStore` sets it on load / New / Open / Save As.
 *
 * Long jobs capture the root once at their start, so a project switch mid-job
 * finishes the job in the folder it started in.
 */

let root: string | null = null

export function getProjectRoot(): string {
  if (!root) throw new Error('No project folder is open.')
  return root
}

export function setProjectRoot(next: string): void {
  root = next
}
