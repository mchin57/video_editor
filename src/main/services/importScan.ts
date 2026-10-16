/**
 * Turning a mixed list of dropped/picked paths into a flat list of importable
 * media files. A directory anywhere in the list is walked; a file is kept only
 * if its extension is one the library actually supports.
 *
 * This is the ONE place that expands directories, so folder import works
 * identically for the File menu, the OS drag-drop onto the window, and any
 * future caller — they all funnel through `importManyReport` in `services/importMany.ts`.
 */

import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from '@shared/media'

/** Every extension the library can import, without the leading dot. */
export const MEDIA_EXTS: readonly string[] = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS]

/** Does this filename look like media we can import? (extension only — the
 *  probe is the real authority, this just avoids probing every stray file.) */
export function isMediaPath(path: string): boolean {
  return MEDIA_EXTS.includes(extname(path).slice(1).toLowerCase())
}

/**
 * Junk that shows up inside real media folders and must never be imported:
 * macOS resource forks (`._clip.mp4` — same extension as the file they shadow,
 * so the extension filter alone lets them through) and hidden/system dirs.
 */
function isJunk(name: string): boolean {
  return name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db'
}

/** Directories that are never worth walking. */
const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])

export type ExpandOptions = {
  /** Walk subdirectories too (default true); false imports only the top level. */
  recursive?: boolean
  /** Safety stop so a mis-drop of a huge tree can't queue thousands of probes. */
  limit?: number
}

/**
 * Expand `paths` into importable media files: directories are walked, files
 * pass through. Order is stable (input order, then alphabetical within a
 * directory) so the library fills predictably, and duplicates are collapsed —
 * dropping both a folder and a file inside it imports that file once.
 *
 * The extension filter applies ONLY to files discovered inside a directory. A
 * path the user named explicitly is always attempted, because the import dialog
 * offers an "All files" filter and picking a file there is a deliberate "try
 * this one" — `importFile` reports a real per-file error, which beats silently
 * dropping the pick.
 *
 * Unreadable entries are skipped rather than thrown: a permission error deep in
 * one subfolder must not sink the whole import.
 */
export async function expandImportPaths(
  paths: string[],
  { recursive = true, limit = 500 }: ExpandOptions = {}
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (p: string): void => {
    if (seen.has(p) || out.length >= limit) return
    seen.add(p)
    out.push(p)
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit) return
    let entries: string[]
    try {
      entries = (await readdir(dir)).sort()
    } catch (err) {
      console.error('import scan failed for', dir, err)
      return
    }
    // Files first, then subdirectories, so a folder's own clips land in the
    // library before anything nested under it.
    const dirs: string[] = []
    for (const name of entries) {
      if (isJunk(name)) continue
      const full = join(dir, name)
      let isDir: boolean
      try {
        isDir = (await stat(full)).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (recursive && depth > 0 && !SKIP_DIRS.has(name)) dirs.push(full)
      } else if (isMediaPath(name)) push(full)
    }
    for (const d of dirs) await walk(d, depth - 1)
  }

  for (const p of paths) {
    let isDir = false
    try {
      isDir = (await stat(p)).isDirectory()
    } catch {
      // Can't even stat it — still hand it to importFile so the user gets the
      // real error for the path they named.
      push(p)
      continue
    }
    if (isDir) await walk(p, 16)
    else push(p)
  }
  return out
}
