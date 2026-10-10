/**
 * Place a file into a project folder WITHOUT doubling disk usage when possible:
 * an NTFS hardlink (`fs.link`) shares the bytes with the source, and the file
 * system's link count becomes the reference count — the space is freed when
 * the last name goes. Across volumes, or on any link failure (FAT/exFAT,
 * network share, permissions), it falls back to a real copy.
 *
 * Verified semantics (docs/PROJECT-FOLDERS.md): moving, renaming or deleting
 * the source leaves the link intact; overwriting the source IN PLACE changes
 * the link too (same bytes) — hence size+mtime change detection on use. And the
 * corollary for us: never write in place to a file that may be a link; write a
 * temp file and rename (the rename replaces the name and breaks the link).
 */

import { promises as fsp } from 'node:fs'

export type Placement = 'link' | 'copy'

/** Error codes from `fs.link` that are the CALLER's problem, not a reason to
 *  copy: the destination already exists, or the source is gone. Every other
 *  failure (EXDEV across volumes, EPERM/ENOTSUP on FAT or shares, EMLINK…)
 *  falls back to a copy. */
export function linkErrorFallsBackToCopy(code: string | undefined): boolean {
  return code !== 'EEXIST' && code !== 'ENOENT'
}

/** Copy via a sibling temp name + rename, so `dest` never names a torn copy. */
export async function copyAtomic(src: string, dest: string): Promise<void> {
  const part = `${dest}.part`
  try {
    await fsp.copyFile(src, part)
    await fsp.rename(part, dest)
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => {})
    throw error
  }
}

/** Hardlink `src` at `dest`, else copy it. Throws if `dest` exists or `src` is missing. */
export async function linkOrCopy(src: string, dest: string): Promise<Placement> {
  try {
    await fsp.link(src, dest)
    return 'link'
  } catch (error) {
    if (!linkErrorFallsBackToCopy((error as NodeJS.ErrnoException).code)) throw error
  }
  await copyAtomic(src, dest)
  return 'copy'
}

/** Move a file we own (a generated output in tmp) — a rename on the same
 *  volume, else copy + delete. */
export async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyAtomic(src, dest)
    await fsp.rm(src, { force: true })
  }
}
