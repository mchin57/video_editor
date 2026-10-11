/**
 * Fingerprinting an original (docs/MEDIA-POINTERS.md): size + sha1 of three
 * fixed-size samples, so checking a multi-GB clip reads a few hundred KB.
 *
 * CONTRACT STUB — signatures are fixed; bodies land with their tests.
 */

import type { Fingerprint, FingerprintField } from '@shared/media'

/** Bytes per sample. A file of at most 3 × this is hashed whole instead. */
export const SAMPLE_BYTES = 256 * 1024

/** Read `path`'s fingerprint. Throws if it can't be read. */
export async function fingerprintFile(path: string): Promise<Fingerprint> {
  void path
  throw new Error('fingerprintFile: not implemented')
}

/** Whether two fingerprints describe the same file content. */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  void a
  void b
  throw new Error('sameFingerprint: not implemented')
}

/** The fields that differ, in the order size, start, middle, end. */
export function fingerprintDiff(a: Fingerprint, b: Fingerprint): FingerprintField[] {
  void a
  void b
  throw new Error('fingerprintDiff: not implemented')
}

/** A 12-hex media id derived from a fingerprint (same content → same id). */
export function fingerprintId(fp: Fingerprint): string {
  void fp
  throw new Error('fingerprintId: not implemented')
}
