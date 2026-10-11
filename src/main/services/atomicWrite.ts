/**
 * Atomic generation of the media store's derived files (proxies, thumbnails,
 * waveforms, display PNGs).
 *
 * Readiness is decided by EXISTENCE — `existsSync(proxy.mp4)` means "ready" —
 * so the final name must never refer to an incomplete file. ffmpeg breaks that
 * if it writes there directly: it creates its output the moment encoding
 * starts (a faststart mp4 is unopenable until the very end), a failed run
 * still finalizes a valid-looking truncated file, and a killed one leaves a
 * torn one. So every generator writes to `partialPath(final)` and renames onto
 * the final name only after it succeeds. See FFMPEG-NOTES "Partial outputs".
 */

import { existsSync, promises as fsp } from 'node:fs'
import { basename, join, parse } from 'node:path'

/**
 * `…/proxy.mp4` → `…/proxy.part.mp4`: same directory (so the rename is atomic),
 * real extension LAST (ffmpeg picks the muxer from it — verified byte-identical
 * output for mp4/m4a/jpg/png). A fixed name, not a random one: a partial left by
 * a crash is simply overwritten (`-y`) by the next attempt instead of piling up.
 */
export function partialPath(finalPath: string): string {
  const { dir, name, ext } = parse(finalPath)
  return join(dir, `${name}.part${ext}`)
}

/**
 * Produce `finalPath` via `write(partPath)`, then rename it into place. If
 * either step fails the partial is deleted and the error rethrown — `finalPath`
 * is only ever absent or complete.
 *
 * The partial name is fixed, so two concurrent writers of one file would share
 * it: callers that can race must coalesce through `singleFlight`.
 */
export async function writeAtomically(
  finalPath: string,
  write: (partPath: string) => Promise<void>
): Promise<void> {
  const part = partialPath(finalPath)
  try {
    await write(part)
    // A writer can "succeed" without writing anything (ffmpeg exits 0 with
    // "Output file is empty, nothing was encoded"): say so, rather than
    // failing the rename with a baffling ENOENT on the partial name.
    if (!existsSync(part)) throw new Error(`${basename(finalPath)} was not written: the command finished without producing a file`)
    await fsp.rename(part, finalPath)
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Coalesce concurrent runs per key: while a run for `key` is in flight, later
 * callers get the SAME promise instead of starting another. The entry clears
 * once it settles, so a call after a failure retries fresh.
 */
export function singleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>()
  return (key, run) => {
    const pending = inFlight.get(key)
    if (pending) return pending
    const promise = run().finally(() => inFlight.delete(key))
    inFlight.set(key, promise)
    return promise
  }
}

/**
 * Replace a small file (a transcript, a project document) via a sibling temp +
 * rename, so a reader sees the old or the new content, never a torn one.
 *
 * On Windows a rename onto a file someone holds open fails EPERM (verified,
 * FFMPEG-NOTES "Partial outputs"); readers here hold files only for a single
 * read, so a few short retries clear it.
 */
export async function replaceFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  await fsp.writeFile(tmp, data)
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw error
      }
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)))
    }
  }
}
