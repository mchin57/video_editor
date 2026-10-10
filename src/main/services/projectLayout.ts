/**
 * On-disk layout of a project folder — pure path math, no I/O. Every main-side
 * path into a project goes through here (media store, protocol, exporter,
 * whisper, assistant). @see docs/PROJECT-FOLDERS.md
 *
 *   <Name>/<Name>.reel     the document
 *   <Name>/autosave.json   the working copy; exists ⇔ unsaved changes
 *   <Name>/media/<id>/     what can't be rebuilt: original.<ext> (a hardlink to
 *                          the source, a copy, or app-generated), asset.json,
 *                          transcript.json
 *   <Name>/cache/<id>/     what can: proxies, thumb, waveform, display PNG,
 *                          whisper scratch. Always safe to delete.
 */

import { basename, dirname, extname, join, parse } from 'node:path'

export const REEL_EXT = 'reel'
export const AUTOSAVE = 'autosave.json'

/** The project document inside a folder: `<root>/<folder name>.reel`. */
export const docPath = (root: string): string => join(root, `${basename(root)}.${REEL_EXT}`)
export const autosavePath = (root: string): string => join(root, AUTOSAVE)

export const mediaRoot = (root: string): string => join(root, 'media')
export const cacheRoot = (root: string): string => join(root, 'cache')
export const mediaDir = (root: string, id: string): string => join(mediaRoot(root), id)
export const cacheDir = (root: string, id: string): string => join(cacheRoot(root), id)

export const assetJsonPath = (root: string, id: string): string => join(mediaDir(root, id), 'asset.json')
export const transcriptPath = (root: string, id: string): string =>
  join(mediaDir(root, id), 'transcript.json')

/** Name of an original inside its media dir, keeping the source's extension
 *  (ffmpeg and the kind detection both read it). */
export function originalName(sourcePath: string): string {
  return `original${extname(sourcePath).toLowerCase()}`
}

/** Derived (cache) files, by role. */
export type CacheFile = 'proxy.mp4' | 'proxy.webm' | 'audio.m4a' | 'image.png' | 'waveform.png' | 'thumb.jpg'
export const cachePath = (root: string, id: string, file: CacheFile): string => join(cacheDir(root, id), file)

/** Media ids are the first 12 hex of a sha1 — the only names the sweep may delete. */
export const isMediaId = (name: string): boolean => /^[0-9a-f]{12}$/.test(name)

/**
 * The folder a Save As writes to, from the `.reel` path the Save dialog
 * returned. Saving `X/Name.reel` creates the project folder `X/Name/` — unless
 * the user already navigated into a folder of that name (`…/Name/Name.reel`,
 * the owner's habit of keeping footage and project together), which then IS
 * the project folder.
 */
export function projectFolderFor(chosenPath: string): string {
  const { dir, name } = parse(chosenPath)
  return basename(dir).toLowerCase() === name.toLowerCase() ? dir : join(dir, name)
}

/** The folder a `.reel` document belongs to (its directory). */
export const rootOfDoc = (reelPath: string): string => dirname(reelPath)

/**
 * Media ids worth keeping in a folder, given the serialized documents that may
 * reference them (the saved `.reel` and the autosave). Deliberately crude: any
 * id that appears ANYWHERE in either text is kept — library list, layers,
 * nested comps, audio-fx provenance — because over-keeping costs disk while
 * under-keeping loses media. Returns the ids from `present` to delete.
 */
export function sweepPlan(present: string[], docs: string[]): string[] {
  return present.filter((id) => isMediaId(id) && !docs.some((d) => d.includes(`"${id}"`)))
}
