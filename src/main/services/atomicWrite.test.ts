import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { partialPath, singleFlight, writeAtomically } from './atomicWrite'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-atomic-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('partialPath', () => {
  it('inserts .part before the extension, keeping the real extension last', () => {
    // ffmpeg picks the muxer from the LAST extension — `proxy.mp4.part` would fail.
    expect(partialPath(join('media', 'ab12', 'proxy.mp4'))).toBe(join('media', 'ab12', 'proxy.part.mp4'))
    expect(partialPath(join('m', 'proxy.webm'))).toBe(join('m', 'proxy.part.webm'))
    expect(partialPath(join('m', 'audio.m4a'))).toBe(join('m', 'audio.part.m4a'))
    expect(partialPath(join('m', 'thumb.jpg'))).toBe(join('m', 'thumb.part.jpg'))
  })

  it('stays in the same directory (rename must not cross volumes)', () => {
    const final = join(dir, 'x', 'waveform.png')
    expect(partialPath(final).startsWith(join(dir, 'x'))).toBe(true)
  })
})

describe('writeAtomically', () => {
  it('the final name does not exist while the write is in progress', async () => {
    const final = join(dir, 'proxy.mp4')
    let seenDuringWrite: boolean | null = null
    await writeAtomically(final, async (part) => {
      await fsp.writeFile(part, 'half')
      seenDuringWrite = existsSync(final)
      await fsp.appendFile(part, ' + rest')
    })
    expect(seenDuringWrite).toBe(false)
    expect(await fsp.readFile(final, 'utf8')).toBe('half + rest')
    expect(existsSync(partialPath(final))).toBe(false)
  })

  it('on failure deletes the partial, leaves no final, and rethrows', async () => {
    // ffmpeg finalizes a valid-but-truncated file even when it exits non-zero,
    // so the partial must not survive to be mistaken for a finished proxy.
    const final = join(dir, 'failed.mp4')
    await expect(
      writeAtomically(final, async (part) => {
        await fsp.writeFile(part, 'truncated but openable')
        throw new Error('ffmpeg exited 183')
      })
    ).rejects.toThrow('ffmpeg exited 183')
    expect(existsSync(final)).toBe(false)
    expect(existsSync(partialPath(final))).toBe(false)
  })

  it('a writer that "succeeds" without writing anything is an error, not a baffling ENOENT', async () => {
    // ffmpeg can exit 0 with "Output file is empty, nothing was encoded" (a
    // JPEG thumb after an input seek — FFMPEG-NOTES "Stills: no input seek").
    const final = join(dir, 'thumb.jpg')
    await expect(writeAtomically(final, async () => {})).rejects.toThrow('thumb.jpg was not written')
    expect(existsSync(final)).toBe(false)
  })

  it('overwrites a stale partial left by an earlier crash', async () => {
    const final = join(dir, 'audio.m4a')
    await fsp.writeFile(partialPath(final), 'stale bytes from a killed run')
    await writeAtomically(final, (part) => fsp.writeFile(part, 'fresh'))
    expect(await fsp.readFile(final, 'utf8')).toBe('fresh')
    expect(readdirSync(dir).filter((f) => f.includes('.part.'))).toEqual([])
  })
})

describe('singleFlight', () => {
  it('concurrent calls for one key share a single run', async () => {
    const flight = singleFlight<number>()
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const run = async (): Promise<number> => {
      runs++
      await gate
      return 42
    }
    const a = flight('asset1', run)
    const b = flight('asset1', run)
    expect(b).toBe(a)
    release()
    expect(await Promise.all([a, b])).toEqual([42, 42])
    expect(runs).toBe(1)
  })

  it('different keys run independently', async () => {
    const flight = singleFlight<string>()
    const [a, b] = await Promise.all([
      flight('a', async () => 'A'),
      flight('b', async () => 'B')
    ])
    expect([a, b]).toEqual(['A', 'B'])
  })

  it('clears the key once settled, so a later call runs again (retry after failure)', async () => {
    const flight = singleFlight<string>()
    let runs = 0
    await expect(
      flight('k', async () => {
        runs++
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(
      await flight('k', async () => {
        runs++
        return 'ok'
      })
    ).toBe('ok')
    expect(runs).toBe(2)
  })
})
