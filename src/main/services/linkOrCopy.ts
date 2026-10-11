/**
 * Placing APP-OWNED files (never the user's footage — library items point at
 * originals in place, docs/MEDIA-POINTERS.md): `linkOrCopy` shares a cache file
 * from the old global store during conversion via an NTFS hardlink (no extra
 * disk), falling back to a real copy across volumes or on any link failure;
 * `copyAtomic` copies generated media / transcripts; `moveFile` adopts a
 * generated output into `generated/`.
 *
 * Hardlink semantics verified for the schema-24 model (docs/PROJECT-FOLDERS.md):
 * a link survives the source being moved, renamed or deleted, but an in-place
 * overwrite of the source changes it too — fine for cache files, which are
 * never written in place.
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
