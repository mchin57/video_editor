import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Fingerprint } from '@shared/media'
import { SAMPLE_BYTES as S, fingerprintDiff, fingerprintFile, fingerprintId, sameFingerprint } from './fingerprint'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-fp-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

/** Deterministic non-repeating bytes, so every sample hashes differently. */
function bytes(n: number): Buffer {
  const b = Buffer.alloc(n)
  let x = 12345
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    b[i] = x >>> 24
  }
  return b
}

function fileOf(name: string, b: Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, b)
  return p
}

function flipped(b: Buffer, at: number): Buffer {
  const c = Buffer.from(b)
  c[at] ^= 0xff
  return c
}

describe('fingerprintFile', () => {
  it('hashes a small file whole, into all three fields', async () => {
    const b = bytes(1000)
    const fp = await fingerprintFile(fileOf('small.mov', b))
    expect(fp).toEqual({ size: 1000, start: sha1(b), middle: sha1(b), end: sha1(b) })
  })

  it('hashes an empty file and one of exactly 3 × S whole', async () => {
    const empty = await fingerprintFile(fileOf('empty', Buffer.alloc(0)))
    expect(empty.size).toBe(0)
    expect(empty.start).toBe(sha1(Buffer.alloc(0)))
    const b = bytes(3 * S)
    expect(await fingerprintFile(fileOf('edge', b))).toEqual({
      size: 3 * S,
      start: sha1(b),
      middle: sha1(b),
      end: sha1(b)
    })
  })

  it('samples a file just over 3 × S at start, floor((size - S) / 2) and the tail', async () => {
    const b = bytes(3 * S + 1)
    const fp = await fingerprintFile(fileOf('over', b))
    expect(fp).toEqual({
      size: 3 * S + 1,
      start: sha1(b.subarray(0, S)),
      middle: sha1(b.subarray(S, 2 * S)),
      end: sha1(b.subarray(2 * S + 1))
    })
    // Byte 2S sits in no sample: changing it is invisible (that's the trade-off).
    expect(await fingerprintFile(fileOf('gap', flipped(b, 2 * S)))).toEqual(fp)
  })

  it('a changed byte shows up only in the sample that covers it', async () => {
    const b = bytes(4 * S)
    const base = await fingerprintFile(fileOf('base', b))
    const at = async (i: number): Promise<Fingerprint> => fingerprintFile(fileOf(`flip${i}`, flipped(b, i)))
    expect(fingerprintDiff(base, await at(0))).toEqual(['start'])
    expect(fingerprintDiff(base, await at(2 * S))).toEqual(['middle'])
    expect(fingerprintDiff(base, await at(4 * S - 1))).toEqual(['end'])
  })

  it('a size change is reported first', async () => {
    const b = bytes(4 * S)
    const base = await fingerprintFile(fileOf('base', b))
    const longer = await fingerprintFile(fileOf('longer', Buffer.concat([b, Buffer.from([1])])))
    expect(fingerprintDiff(base, longer)[0]).toBe('size')
    expect(sameFingerprint(base, longer)).toBe(false)
  })

  it('throws for a missing file', async () => {
    await expect(fingerprintFile(join(dir, 'gone.mov'))).rejects.toThrow()
  })
})

describe('sameFingerprint / fingerprintDiff', () => {
  const fp: Fingerprint = { size: 10, start: 'a', middle: 'b', end: 'c' }
  it('equal fingerprints have no diff', () => {
    expect(sameFingerprint(fp, { ...fp })).toBe(true)
    expect(fingerprintDiff(fp, { ...fp })).toEqual([])
  })
  it('lists differing fields in the order size, start, middle, end', () => {
    expect(fingerprintDiff(fp, { size: 11, start: 'x', middle: 'y', end: 'z' })).toEqual([
      'size',
      'start',
      'middle',
      'end'
    ])
    expect(fingerprintDiff(fp, { ...fp, end: 'z', start: 'x' })).toEqual(['start', 'end'])
  })
})

describe('fingerprintId', () => {
  const fp: Fingerprint = { size: 10, start: 'a', middle: 'b', end: 'c' }
  it('is 12 hex of sha1("size:start:middle:end") — pinned, saved ids depend on it', () => {
    expect(fingerprintId(fp)).toBe(createHash('sha1').update('10:a:b:c').digest('hex').slice(0, 12))
    expect(fingerprintId(fp)).toBe('7fa5e5bfc9ab')
  })
  it('same content → same id; any field change → a different id', () => {
    expect(fingerprintId({ ...fp })).toBe(fingerprintId(fp))
    for (const other of [
      { ...fp, size: 11 },
      { ...fp, start: 'x' },
      { ...fp, middle: 'x' },
      { ...fp, end: 'x' }
    ]) {
      expect(fingerprintId(other)).not.toBe(fingerprintId(fp))
    }
  })
})
