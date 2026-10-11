/**
 * On-disk layout of a project folder — pure path math, no I/O. Every main-side
 * path into a project goes through here (media store, protocol, exporter,
 * whisper, assistant). @see docs/MEDIA-POINTERS.md "The project folder"
 *
 *   <Name>/<Name>.reel        the save file: document + library (only Save writes it)
 *   <Name>/autosave.json      crash recovery; exists ⇔ unsaved changes
 *   <Name>/generated/         media the editor made (background removal, audio fx,
 *                             extracted audio, stills), as real files
 *   <Name>/transcripts/<id>.json  whisper word timings (slow to rebuild)
 *   <Name>/cache/<id>/        proxies, thumb, waveform, display PNG, whisper
 *                             scratch. Always safe to delete.
 *
 * Originals are NOT in the folder: library items point at them where they are.
 */

import { basename, dirname, extname, join, parse } from 'node:path'

export const REEL_EXT = 'reel'
export const AUTOSAVE = 'autosave.json'

/** The project document inside a folder: `<root>/<folder name>.reel`. */
export const docPath = (root: string): string => join(root, `${basename(root)}.${REEL_EXT}`)
export const autosavePath = (root: string): string => join(root, AUTOSAVE)

export const generatedRoot = (root: string): string => join(root, 'generated')
export const transcriptsRoot = (root: string): string => join(root, 'transcripts')
export const cacheRoot = (root: string): string => join(root, 'cache')
export const cacheDir = (root: string, id: string): string => join(cacheRoot(root), id)
export const transcriptPath = (root: string, id: string): string => join(transcriptsRoot(root), `${id}.json`)

/** The folders New creates (and Open re-creates if someone deleted one). */
export const projectSubdirs = (root: string): string[] => [generatedRoot(root), transcriptsRoot(root), cacheRoot(root)]

/** Derived (cache) files, by role. */
export type CacheFile = 'proxy.mp4' | 'proxy.webm' | 'audio.m4a' | 'image.png' | 'waveform.png' | 'thumb.jpg'
export const cachePath = (root: string, id: string, file: CacheFile): string => join(cacheDir(root, id), file)

/** Media ids are 12 hex — the only names the cache sweep may delete. */
export const isMediaId = (name: string): boolean => /^[0-9a-f]{12}$/.test(name)

/**
 * A display name made safe as a Windows file name, for generated media saved
 * in `generated/` (the library keeps showing the display name itself). `:` —
 * which time ranges like "0:03–0:05" carry — becomes `.`; the other forbidden
 * characters and control characters become `_`; trailing dots and spaces go;
 * a reserved device name (CON, NUL, COM1, …) gets a leading `_`.
 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/:/g, '.').replace(/[<>"/\\|?*\u0000-\u001f]/g, '_')
  safe = safe.replace(/[. ]+$/, '').trim()
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safe)) safe = `_${safe}`
  return safe || 'media'
}

/**
 * A free file name for generated media: `name` itself, else `name (2)`,
 * `name (3)`… before the extension. `taken` says whether a name is in use.
 */
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
}

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
 * Cache entries worth keeping, given the serialized documents that may
 * reference them (the saved `.reel` and the autosave). Deliberately crude: any
 * id that appears ANYWHERE in either text is kept, because over-keeping costs
 * disk while under-keeping costs a rebuild. Returns the ids from `present` to
 * delete.
 */
export function sweepPlan(present: string[], docs: string[]): string[] {
  return present.filter((id) => isMediaId(id) && !docs.some((d) => d.includes(`"${id}"`)))
}

// --- Schema-24 (hard-link) layout: read only by legacy conversion ------------

/** @deprecated schema 24 only — where that layout kept originals and records. */
export const mediaRoot = (root: string): string => join(root, 'media')
/** @deprecated schema 24 only. */
export const mediaDir = (root: string, id: string): string => join(mediaRoot(root), id)
/** @deprecated schema 24 only. */
export const assetJsonPath = (root: string, id: string): string => join(mediaDir(root, id), 'asset.json')
/** @deprecated schema 24 only: `original.<ext>` inside a media dir. */
export function originalName(sourcePath: string): string {
  return `original${extname(sourcePath).toLowerCase()}`
}
