/**
 * Fingerprinting an original (docs/MEDIA-POINTERS.md): size + sha1 of three
 * fixed-size samples, so checking a multi-GB clip reads a few hundred KB.
 *
 * Samples of S = SAMPLE_BYTES: start = [0, S), middle = S bytes from
 * floor((size - S) / 2), end = the last S bytes. A file of at most 3 × S is
 * hashed whole and that digest fills all three fields.
 */

import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import type { Fingerprint, FingerprintField } from '@shared/media'

/** Bytes per sample. A file of at most 3 × this is hashed whole instead. */
export const SAMPLE_BYTES = 256 * 1024

const FIELDS: FingerprintField[] = ['size', 'start', 'middle', 'end']

const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex')

/** Exactly `length` bytes from `position`; throws if the file ends first. */
async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got)
    if (bytesRead === 0) throw new Error(`file ended at byte ${position + got} while fingerprinting`)
    got += bytesRead
  }
  return buf
}

/** Read `path`'s fingerprint. Throws if it can't be read. */
export async function fingerprintFile(path: string): Promise<Fingerprint> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const S = SAMPLE_BYTES
    if (size <= 3 * S) {
      const whole = sha1(await readAt(fh, 0, size))
      return { size, start: whole, middle: whole, end: whole }
    }
    return {
      size,
      start: sha1(await readAt(fh, 0, S)),
      middle: sha1(await readAt(fh, Math.floor((size - S) / 2), S)),
      end: sha1(await readAt(fh, size - S, S))
    }
  } finally {
    await fh.close()
  }
}

/** Whether two fingerprints describe the same file content. */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return fingerprintDiff(a, b).length === 0
}

/** The fields that differ, in the order size, start, middle, end. */
export function fingerprintDiff(a: Fingerprint, b: Fingerprint): FingerprintField[] {
  return FIELDS.filter((f) => a[f] !== b[f])
}

/**
 * A 12-hex media id derived from a fingerprint (same content → same id): the
 * first 12 hex of sha1 over `${size}:${start}:${middle}:${end}`. Saved ids
 * depend on this exact string — never change it.
 */
export function fingerprintId(fp: Fingerprint): string {
  return sha1(`${fp.size}:${fp.start}:${fp.middle}:${fp.end}`).slice(0, 12)
}
