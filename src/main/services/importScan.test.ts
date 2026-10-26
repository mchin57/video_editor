import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { expandImportPaths, isMediaPath } from './importScan'

/** A tree with media at two depths plus the junk a real media folder carries. */
let root = ''
const rel = (p: string): string =>
  p
    .slice(root.length + 1)
    .split(sep)
    .join('/')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'reel-scan-'))
  await mkdir(join(root, 'sub', 'deeper'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  for (const f of [
    'b.mp4',
    'a.mov',
    'song.mp3',
    'still.png',
    'notes.txt',
    '._a.mov',
    '.DS_Store',
    'sub/nested.mp4',
    'sub/deeper/deep.wav',
    'node_modules/pkg.mp4'
  ]) {
    await writeFile(join(root, ...f.split('/')), '')
  }
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('isMediaPath', () => {
  it('accepts video/audio/image extensions, case-insensitively', () => {
    expect(isMediaPath('a.mp4')).toBe(true)
    expect(isMediaPath('a.MOV')).toBe(true)
    expect(isMediaPath('a.mp3')).toBe(true)
    expect(isMediaPath('a.PNG')).toBe(true)
    expect(isMediaPath('Morning_Ride.fit')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isMediaPath('a.txt')).toBe(false)
    expect(isMediaPath('a.reel')).toBe(false)
    expect(isMediaPath('noext')).toBe(false)
  })
})

describe('expandImportPaths', () => {
  it('walks a directory into its media files, alphabetically, top level first', async () => {
    expect((await expandImportPaths([root])).map(rel)).toEqual([
      'a.mov',
      'b.mp4',
      'song.mp3',
      'still.png',
      'sub/nested.mp4',
      'sub/deeper/deep.wav'
    ])
  })

  it('skips non-media, macOS resource forks and OS junk inside a folder', async () => {
    const got = (await expandImportPaths([root])).map(rel)
    expect(got).not.toContain('notes.txt')
    expect(got).not.toContain('._a.mov')
    expect(got).not.toContain('.DS_Store')
    expect(got).not.toContain('node_modules/pkg.mp4')
  })

  it('stays at the top level when recursive is off', async () => {
    const got = (await expandImportPaths([root], { recursive: false })).map(rel)
    expect(got).toEqual(['a.mov', 'b.mp4', 'song.mp3', 'still.png'])
  })

  it('honours the limit so a mis-dropped tree cannot flood the library', async () => {
    expect(await expandImportPaths([root], { limit: 2 })).toHaveLength(2)
  })

  it('passes an explicitly named file through even if the extension is unknown', async () => {
    // The dialog offers an "All files" filter; picking one there is deliberate,
    // so the extension filter must apply only INSIDE a walked directory.
    const p = join(root, 'notes.txt')
    expect(await expandImportPaths([p])).toEqual([p])
  })

  it('passes an unstattable path through so importFile can report the real error', async () => {
    const missing = join(root, 'gone.mp4')
    expect(await expandImportPaths([missing])).toEqual([missing])
  })

  it('collapses duplicates across a folder and a file inside it', async () => {
    const got = await expandImportPaths([join(root, 'sub', 'nested.mp4'), join(root, 'sub')])
    expect(got.filter((p) => p.endsWith('nested.mp4'))).toHaveLength(1)
  })

  it('keeps input order across several roots', async () => {
    const got = (await expandImportPaths([join(root, 'sub'), join(root, 'song.mp3')])).map(rel)
    expect(got).toEqual(['sub/nested.mp4', 'sub/deeper/deep.wav', 'song.mp3'])
  })
})
