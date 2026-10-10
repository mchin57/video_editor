import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkErrorFallsBackToCopy, linkOrCopy, moveFile } from './linkOrCopy'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-link-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('linkErrorFallsBackToCopy', () => {
  it('copies on cross-volume and unsupported-link errors', () => {
    for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EACCES', undefined]) {
      expect(linkErrorFallsBackToCopy(code)).toBe(true)
    }
  })
  it('surfaces caller errors instead of copying', () => {
    expect(linkErrorFallsBackToCopy('EEXIST')).toBe(false)
    expect(linkErrorFallsBackToCopy('ENOENT')).toBe(false)
  })
})

describe('linkOrCopy (same volume)', () => {
  it('hardlinks: one set of bytes, two names', async () => {
    const src = join(dir, 'clip.mov')
    writeFileSync(src, 'footage')
    const dest = join(dir, 'original.mov')
    expect(await linkOrCopy(src, dest)).toBe('link')
    expect(statSync(dest).nlink).toBe(2)
    expect(statSync(dest).ino).toBe(statSync(src).ino)
  })

  it('survives the source being renamed or deleted', async () => {
    const src = join(dir, 'clip.mov')
    writeFileSync(src, 'footage')
    const dest = join(dir, 'original.mov')
    await linkOrCopy(src, dest)
    renameSync(src, join(dir, 'moved.mov'))
    rmSync(join(dir, 'moved.mov'))
    expect(readFileSync(dest, 'utf8')).toBe('footage')
  })

  it('throws rather than overwrite an existing destination', async () => {
    const src = join(dir, 'a')
    const dest = join(dir, 'b')
    writeFileSync(src, '1')
    writeFileSync(dest, '2')
    await expect(linkOrCopy(src, dest)).rejects.toThrow()
    expect(readFileSync(dest, 'utf8')).toBe('2')
  })

  it('throws for a missing source and leaves nothing behind', async () => {
    await expect(linkOrCopy(join(dir, 'gone'), join(dir, 'dest'))).rejects.toThrow()
    expect(existsSync(join(dir, 'dest'))).toBe(false)
  })
})

describe('moveFile', () => {
  it('renames a generated file into place', async () => {
    const src = join(dir, 'tmp.wav')
    writeFileSync(src, 'wav')
    await moveFile(src, join(dir, 'original.wav'))
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(join(dir, 'original.wav'), 'utf8')).toBe('wav')
  })
})
