/**
 * Imported colour LUTs (`.cube`): copied INTO the project folder's `luts/` so a
 * project keeps working when the original moves, and named by their content's
 * hash so the same table imported twice (or from a template, or the shared
 * library) is stored once. A file is parsed (`parseCube`) before it is taken:
 * one we can't read is refused with the reason, never copied in.
 *
 * `LutRef.file` is the stored name; `readLut` gives the parsed table back to the
 * export, the stills and (over IPC) the preview. @see shared/cube.ts
 */

import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { CubeError, parseCube, type CubeTable } from '@shared/cube'
import type { ImportedLut } from '@shared/ipc'
import { cleanTemplateName } from '@shared/templates'
import { writeAtomically } from './atomicWrite'
import { isLutFileName, lutPath, lutsRoot } from './projectLayout'

/** Largest `.cube` taken (a 65-point table is about 8 MB of text; 256 points is ~400 MB). */
export const MAX_LUT_BYTES = 64 * 1024 * 1024

export type { ImportedLut }

/** The stored name for a table's bytes: 16 hex of their SHA-1, `.cube`. */
export const lutFileFor = (bytes: Buffer): string =>
  `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.cube`

/** Check a table's bytes are one we can use; throws a readable error that calls it `label`. */
export function parseLutBytes(bytes: Buffer, label: string): CubeTable {
  if (bytes.length > MAX_LUT_BYTES) throw new Error(`“${label}” is too large to be a LUT.`)
  try {
    return parseCube(bytes.toString('latin1'))
  } catch (error) {
    if (error instanceof CubeError) throw new Error(`“${label}” isn’t a LUT we can use: ${error.message}`)
    throw error
  }
}

/** Read a candidate file and check it is a table we can use; throws a readable error. */
export async function readLutFile(path: string): Promise<{ bytes: Buffer; table: CubeTable }> {
  const stat = await fsp.stat(path).catch(() => null)
  if (!stat?.isFile()) throw new Error(`“${basename(path)}” could not be found.`)
  if (stat.size > MAX_LUT_BYTES) throw new Error(`“${basename(path)}” is too large to be a LUT.`)
  const bytes = await fsp.readFile(path)
  return { bytes, table: parseLutBytes(bytes, basename(path)) }
}

/**
 * Copy the `.cube` at `path` into `<root>/luts/` (unless the same table is
 * already there) and return its stored name and display name. Throws, with
 * the reason, for a file that isn't a usable table.
 */
export async function importLut(root: string, path: string): Promise<ImportedLut> {
  const { bytes } = await readLutFile(path)
  return { file: await storeLut(root, bytes), name: lutDisplayName(path) }
}

/** Put a table's bytes (already checked) into `<root>/luts/`, once; its stored name. */
export async function storeLut(root: string, bytes: Buffer): Promise<string> {
  const file = lutFileFor(bytes)
  const dest = join(lutsRoot(root), file)
  if (!existsSync(dest)) {
    await fsp.mkdir(lutsRoot(root), { recursive: true })
    await writeAtomically(dest, (part) => fsp.writeFile(part, bytes))
  }
  return file
}

/** A file's name as the Inspector shows it: without `.cube`, trimmed and capped. */
export const lutDisplayName = (path: string): string =>
  cleanTemplateName(basename(path, extname(path)).replace(/[_]+/g, ' ')) ?? 'LUT'

/** Parsed tables by path — files are content-named, so a name never changes meaning. */
const cache = new Map<string, CubeTable>()

/**
 * The parsed table a `LutRef.file` names in project `root`. Throws a readable
 * error when the name is not one the editor writes or the file has gone.
 */
export async function readLut(root: string, file: string): Promise<CubeTable> {
  const path = lutPath(root, file)
  if (!path) throw new Error(`“${file}” is not a LUT name this editor writes.`)
  const hit = cache.get(path)
  if (hit) return hit
  if (!existsSync(path)) throw new Error(`The LUT file ${file} is missing from the project’s luts folder.`)
  const { table } = await readLutFile(path)
  if (cache.size > 32) cache.clear()
  cache.set(path, table)
  return table
}

export { isLutFileName }
