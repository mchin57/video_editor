import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import type { Fingerprint } from '@shared/media'
import { fingerprintFile } from './fingerprint'
import {
  decideResolution,
  fromRelativePath,
  locateOriginal,
  relativePathWith,
  samePath,
  toRelativePath,
  type PathCheck
} from './mediaRef'

const W = path.win32

describe('relativePathWith (win32 rules)', () => {
  it('a file inside the project folder', () => {
    expect(relativePathWith(W, 'C:\\Reels\\Trip', 'C:\\Reels\\Trip\\sub\\file.mov')).toBe('sub/file.mov')
  })
  it('a sibling folder', () => {
    expect(relativePathWith(W, 'C:\\Reels\\Trip', 'C:\\Reels\\footage\\x.mov')).toBe('../footage/x.mov')
  })
  it('another drive has no relative path', () => {
    expect(relativePathWith(W, 'C:\\Reels\\Trip', 'D:\\footage\\x.mov')).toBeNull()
  })
  it('ignores case like Windows does', () => {
    expect(relativePathWith(W, 'C:\\Reels\\Trip', 'c:\\reels\\TRIP\\a.mov')).toBe('a.mov')
  })
})

describe('relativePathWith (posix rules)', () => {
  it('a sibling folder', () => {
    expect(relativePathWith(path.posix, '/home/u/Trip', '/home/u/footage/x.mov')).toBe('../footage/x.mov')
  })
})

describe('samePath', () => {
  it('is case-insensitive and normalizing under win32', () => {
    expect(samePath('C:\\Reels\\A.mov', 'c:/reels/./a.MOV', W)).toBe(true)
    expect(samePath('C:\\Reels\\A.mov', 'D:\\Reels\\A.mov', W)).toBe(false)
  })
  it('is case-sensitive under posix', () => {
    expect(samePath('/a/B.mov', '/a/b.mov', path.posix)).toBe(false)
    expect(samePath('/a/./b.mov', '/a/b.mov', path.posix)).toBe(true)
  })
})

describe('toRelativePath / fromRelativePath', () => {
  it('round-trip on this platform', () => {
    const proj = path.resolve(tmpdir(), 'Reels', 'Trip')
    const abs = path.resolve(tmpdir(), 'Reels', 'footage', 'x.mov')
    expect(toRelativePath(proj, abs)).toBe('../footage/x.mov')
    expect(fromRelativePath(proj, '../footage/x.mov')).toBe(abs)
    expect(fromRelativePath(proj, 'sub/./y.mov')).toBe(path.join(proj, 'sub', 'y.mov'))
  })
})

describe('decideResolution', () => {
  const fp: Fingerprint = { size: 100, start: 'a', middle: 'b', end: 'c' }
  const other: Fingerprint = { ...fp, middle: 'x' }
  const proj = path.resolve(tmpdir(), 'Reels', 'Trip')
  const here = join(proj, 'footage', 'a.mov') // where relativePath 'footage/a.mov' points
  const elsewhere = path.resolve(tmpdir(), 'Old', 'a.mov')
  const check = (p: string, f: Fingerprint | null): PathCheck => ({ path: p, fingerprint: f })

  it('relative matches, absolute already agrees → no update', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: here, fingerprint: fp }
    expect(decideResolution(rec, proj, check(here, fp), null)).toEqual({ path: here, found: 'relative', update: {} })
  })

  it('relative matches, absolute stale → absolutePath updated', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: elsewhere, fingerprint: fp }
    expect(decideResolution(rec, proj, check(here, fp), check(elsewhere, null))).toEqual({
      path: here,
      found: 'relative',
      update: { absolutePath: here }
    })
  })

  it('both match → relative wins, stale absolute updated', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: elsewhere, fingerprint: fp }
    expect(decideResolution(rec, proj, check(here, fp), check(elsewhere, fp))).toEqual({
      path: here,
      found: 'relative',
      update: { absolutePath: here }
    })
  })

  it('only absolute matches → relativePath updated', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: elsewhere, fingerprint: fp }
    expect(decideResolution(rec, proj, check(here, null), check(elsewhere, fp))).toEqual({
      path: elsewhere,
      found: 'absolute',
      update: { relativePath: toRelativePath(proj, elsewhere) }
    })
  })

  it('a file at the relative path with the wrong content is not used', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: elsewhere, fingerprint: fp }
    expect(decideResolution(rec, proj, check(here, other), check(elsewhere, fp)).found).toBe('absolute')
    expect(decideResolution(rec, proj, check(here, other), check(elsewhere, other))).toEqual({
      path: null,
      found: null,
      update: {}
    })
  })

  it('neither matches → missing, nothing to update', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: elsewhere, fingerprint: fp }
    expect(decideResolution(rec, proj, check(here, null), check(elsewhere, null))).toEqual({
      path: null,
      found: null,
      update: {}
    })
  })

  it('no relative path recorded, absolute matches → relativePath filled in', () => {
    const rec = { relativePath: null, absolutePath: here, fingerprint: fp }
    expect(decideResolution(rec, proj, null, check(here, fp))).toEqual({
      path: here,
      found: 'absolute',
      update: { relativePath: 'footage/a.mov' }
    })
  })

  it('absolute matches and the recorded relative path already agrees → no update', () => {
    const rec = { relativePath: '../../Old/a.mov', absolutePath: elsewhere, fingerprint: fp }
    expect(toRelativePath(proj, elsewhere)).toBe('../../Old/a.mov')
    expect(
      decideResolution(rec, proj, check(fromRelativePath(proj, '../../Old/a.mov'), null), check(elsewhere, fp)).update
    ).toEqual({})
  })

  it.runIf(process.platform === 'win32')('Windows: another drive → relativePath becomes null', () => {
    const rec = { relativePath: 'footage/a.mov', absolutePath: 'Z:\\footage\\a.mov', fingerprint: fp }
    expect(
      decideResolution(
        rec,
        'C:\\Reels\\Trip',
        check('C:\\Reels\\Trip\\footage\\a.mov', null),
        check('Z:\\footage\\a.mov', fp)
      )
    ).toEqual({
      path: 'Z:\\footage\\a.mov',
      found: 'absolute',
      update: { relativePath: null }
    })
  })

  it.runIf(process.platform === 'win32')('Windows: a case-only difference is not an update', () => {
    const rec = { relativePath: 'Footage/A.mov', absolutePath: 'C:\\REELS\\Trip\\FOOTAGE\\a.MOV', fingerprint: fp }
    const found = 'c:\\reels\\trip\\footage\\a.mov'
    expect(decideResolution(rec, 'C:\\Reels\\Trip', check(found, fp), null).update).toEqual({})
    expect(decideResolution(rec, 'C:\\Reels\\Trip', check(found, null), check(found, fp)).update).toEqual({})
  })
})

describe('locateOriginal (real files)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reel-ref-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function put(rel: string, content: string): string {
    const p = join(root, ...rel.split('/'))
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, content)
    return p
  }

  /** A reader that counts calls, so tests see when samples were read. */
  function countingReader(): { read: (p: string) => Promise<Fingerprint>; calls: string[] } {
    const calls: string[] = []
    return { calls, read: async (p) => (calls.push(p), fingerprintFile(p)) }
  }

  it('project moved together with its footage → relative found, absolute updated', async () => {
    const now = put('Moved/Trip/footage/a.mov', 'clip-a')
    const rec = {
      relativePath: 'footage/a.mov',
      absolutePath: join(root, 'Old', 'Trip', 'footage', 'a.mov'),
      fingerprint: await fingerprintFile(now)
    }
    const r = countingReader()
    expect(await locateOriginal(rec, join(root, 'Moved', 'Trip'), r.read)).toEqual({
      path: now,
      found: 'relative',
      update: { absolutePath: now }
    })
    expect(r.calls).toEqual([now]) // the absolute side was never sampled
  })

  it('project moved alone → absolute found, relative updated', async () => {
    const clip = put('footage/a.mov', 'clip-a')
    const rec = { relativePath: '../footage/a.mov', absolutePath: clip, fingerprint: await fingerprintFile(clip) }
    const proj = join(root, 'Moved', 'Trip')
    expect(await locateOriginal(rec, proj)).toEqual({
      path: clip,
      found: 'absolute',
      update: { relativePath: '../../footage/a.mov' }
    })
  })

  it('no relative path recorded → absolute is checked', async () => {
    const clip = put('footage/a.mov', 'clip-a')
    const rec = { relativePath: null, absolutePath: clip, fingerprint: await fingerprintFile(clip) }
    const res = await locateOriginal(rec, join(root, 'Trip'))
    expect(res.found).toBe('absolute')
    expect(res.update).toEqual({ relativePath: '../footage/a.mov' })
  })

  it('a same-size file with different content is missing', async () => {
    const clip = put('Trip/a.mov', 'clip-a')
    const rec = { relativePath: 'a.mov', absolutePath: clip, fingerprint: await fingerprintFile(clip) }
    writeFileSync(clip, 'clip-b')
    expect(await locateOriginal(rec, join(root, 'Trip'))).toEqual({ path: null, found: null, update: {} })
  })

  it('a size mismatch or a missing file is decided by stat alone — no samples read', async () => {
    const clip = put('Trip/a.mov', 'clip-a')
    const rec = {
      relativePath: 'a.mov',
      absolutePath: join(root, 'gone.mov'),
      fingerprint: await fingerprintFile(clip)
    }
    writeFileSync(clip, 'clip-a, re-encoded')
    const r = countingReader()
    expect(await locateOriginal(rec, join(root, 'Trip'), r.read)).toEqual({ path: null, found: null, update: {} })
    expect(r.calls).toEqual([])
  })
})
