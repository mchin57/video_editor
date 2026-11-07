/**
 * Shared library storage against a real temp folder (probe and thumbnail
 * faked, so no ffmpeg): adding COPIES the file in (it survives the original
 * going), the same content is never copied twice, a file of the wrong kind or
 * one that can't be read is skipped and leaves nothing behind, a picture the
 * browser can draw is its own preview while others get a thumbnail, damaged or
 * orphaned folders are skipped, text pieces save (same name replaces), and
 * rename / delete / the file to copy into a project behave.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeInfo } from '@shared/media'
import { makeImageLayer, makeTextLayer } from '@shared/layers'
import { SHARED_ITEM_JSON } from '@shared/sharedLibrary'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

import {
  addSharedFiles,
  deleteShared,
  listShared,
  renameShared,
  saveSharedText,
  sharedFile,
  type SharedDeps
} from './sharedLibrary'

let dir: string
let root: string
let src: string

const audioProbe: ProbeInfo = {
  durationSec: 0.4,
  container: 'wav',
  video: null,
  audio: { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 }
}
const videoStream = {
  codec: 'h264',
  width: 1080,
  height: 1920,
  displayWidth: 1080,
  displayHeight: 1920,
  rotationDeg: 0,
  avgFps: 30,
  rFps: 30,
  isVfr: false,
  pixFmt: 'yuv420p',
  colorTransfer: null,
  colorPrimaries: null,
  colorSpace: null,
  isHdr: false
}
const videoProbe: ProbeInfo = { durationSec: 5, container: 'mov,mp4', video: videoStream, audio: null }
const imageProbe: ProbeInfo = {
  durationSec: 0,
  container: 'image2',
  video: { ...videoStream, codec: 'png' },
  audio: null
}

/** Probe by extension; `thumbnail` writes a file unless told to fail. */
function fakeDeps(opts: { thumbFails?: boolean } = {}): SharedDeps & { thumbs: string[] } {
  const thumbs: string[] = []
  return {
    thumbs,
    probe: async (p) => {
      if (p.endsWith('.wav') || p.endsWith('.mp3')) return audioProbe
      if (p.endsWith('.mp4')) return videoProbe
      if (p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.heic')) return imageProbe
      throw new Error('not media')
    },
    thumbnail: async (input, output) => {
      thumbs.push(input)
      if (opts.thumbFails) throw new Error('ffmpeg said no')
      writeFileSync(output, 'JPEG')
    }
  }
}

const write = (name: string, content: string): string => {
  const p = join(src, name)
  writeFileSync(p, content)
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-shared-'))
  root = join(dir, 'shared')
  src = join(dir, 'src')
  mkdirSync(src)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('addSharedFiles', () => {
  it('copies a sound in, so it survives the original going', async () => {
    const p = write('Whoosh.wav', 'WHOOSH')
    const res = await addSharedFiles(root, [p], fakeDeps(), 'sound')
    expect(res.added).toHaveLength(1)
    expect(res.skipped).toEqual([])
    const [item] = res.items
    expect(item).toMatchObject({ name: 'Whoosh', kind: 'sound', file: 'Whoosh.wav', durationSec: 0.4, preview: null })
    rmSync(p)
    expect(await listShared(root)).toEqual(res.items)
    const { path, displayName } = await sharedFile(root, item.id)
    expect(existsSync(path)).toBe(true)
    expect(displayName).toBe('Whoosh.wav')
  })

  it('never copies the same content twice, even under another name', async () => {
    const deps = fakeDeps()
    const first = await addSharedFiles(root, [write('a.wav', 'SAME')], deps)
    const again = await addSharedFiles(root, [write('b.wav', 'SAME')], deps)
    expect(again.added).toEqual([])
    expect(again.already).toEqual(first.added)
    expect(again.items).toHaveLength(1)
  })

  it('skips a file of the wrong kind for the tab, and a file that is not media, leaving nothing behind', async () => {
    const res = await addSharedFiles(root, [write('clip.mp4', 'VID'), write('notes.txt', 'hi')], fakeDeps(), 'sound')
    expect(res.added).toEqual([])
    expect(res.skipped.map((s) => s.name)).toEqual(['clip.mp4', 'notes.txt'])
    expect(res.skipped[0].reason).toBe("It isn't a sound, so it belongs on the Video tab.")
    expect(res.skipped[1].reason).toBe("It couldn't be read as a sound, picture or video.")
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses a workout file', async () => {
    const deps = fakeDeps()
    deps.probe = async () => ({ ...audioProbe, audio: null, workout: {} as never })
    const res = await addSharedFiles(root, [write('ride.fit', 'FIT')], deps)
    expect(res.skipped[0].reason).toMatch(/Only sounds, pictures and video/)
    expect(readdirSync(root)).toEqual([])
  })

  it('one file failing never stops the rest', async () => {
    const res = await addSharedFiles(root, [write('bad.txt', 'x'), write('ok.wav', 'OK')], fakeDeps())
    expect(res.skipped).toHaveLength(1)
    expect(res.added).toHaveLength(1)
  })

  it('shows a PNG as itself, but makes a thumbnail for a HEIC and a video', async () => {
    const deps = fakeDeps()
    const res = await addSharedFiles(
      root,
      [write('logo.png', 'PNG'), write('photo.heic', 'HEIC'), write('intro.mp4', 'MP4')],
      deps
    )
    const by = Object.fromEntries(res.items.map((i) => [i.name, i]))
    expect(by.logo).toMatchObject({ kind: 'graphic', preview: 'logo.png', durationSec: 0 })
    expect(by.photo).toMatchObject({ kind: 'graphic', preview: 'thumb.jpg' })
    expect(by.intro).toMatchObject({ kind: 'video', preview: 'thumb.jpg', durationSec: 5 })
    expect(deps.thumbs).toHaveLength(2)
  })

  it('a failed thumbnail still adds the item, with no preview', async () => {
    const res = await addSharedFiles(root, [write('intro.mp4', 'MP4')], fakeDeps({ thumbFails: true }))
    expect(res.added).toHaveLength(1)
    expect(res.items[0].preview).toBeNull()
  })

  it('takes the name it is given (a library clip’s display name)', async () => {
    const res = await addSharedFiles(root, [write('IMG_0042.wav', 'X')], fakeDeps(), undefined, () => 'Starting gun')
    expect(res.items[0].name).toBe('Starting gun')
  })
})

describe('listShared', () => {
  it('skips damaged records, folders whose file has gone, and stray files', async () => {
    const res = await addSharedFiles(root, [write('a.wav', 'A'), write('b.wav', 'B')], fakeDeps())
    const [a, b] = res.items
    writeFileSync(join(root, a.id, SHARED_ITEM_JSON), '{ not json')
    rmSync(join(root, b.id, b.file!))
    mkdirSync(join(root, 'empty-folder'))
    writeFileSync(join(root, 'stray.txt'), 'x')
    expect(await listShared(root)).toEqual([])
  })
  it('is empty when the folder does not exist yet', async () => {
    expect(await listShared(join(dir, 'nowhere'))).toEqual([])
  })
})

describe('text pieces', () => {
  it('saves text layers as a text piece; the same name replaces it', async () => {
    const first = await saveSharedText(root, 'Bio', [makeTextLayer('A', 0, 2)])
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'text', name: 'Bio', file: null, durationSec: 2 })
    const second = await saveSharedText(root, 'bio', [makeTextLayer('B', 0, 4)])
    expect(second).toHaveLength(1)
    expect(second[0].durationSec).toBe(4)
    expect(readdirSync(root)).toHaveLength(1)
  })
  it('refuses anything but text layers, writing nothing', async () => {
    await expect(saveSharedText(root, 'Logo', [makeImageLayer('I', 'logo.png', 0, 2)])).rejects.toThrow(
      'Only text layers can be saved as shared text.'
    )
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })
  it('has no file to copy into a project', async () => {
    const [t] = await saveSharedText(root, 'Bio', [makeTextLayer('A', 0, 2)])
    await expect(sharedFile(root, t.id)).rejects.toThrow('A text piece has no file to copy.')
  })
})

describe('rename / delete', () => {
  it('renames only the gallery name', async () => {
    const res = await addSharedFiles(root, [write('w.wav', 'W')], fakeDeps())
    const [item] = await renameShared(root, res.added[0], '  Big whoosh ')
    expect(item.name).toBe('Big whoosh')
    expect(item.file).toBe('w.wav')
    await expect(renameShared(root, item.id, '  ')).rejects.toThrow('Give it a name.')
  })
  it('deletes the folder; a gone or traversing id is refused', async () => {
    const res = await addSharedFiles(root, [write('w.wav', 'W')], fakeDeps())
    expect(await deleteShared(root, res.added[0])).toEqual([])
    expect(readdirSync(root)).toEqual([])
    await expect(deleteShared(root, res.added[0])).rejects.toThrow('That shared item no longer exists.')
    await expect(deleteShared(root, '..')).rejects.toThrow('That shared item no longer exists.')
    expect(existsSync(dir)).toBe(true)
  })
})

describe('edge cases', () => {
  it('a file named like the item’s own files is stored under another name', async () => {
    const res = await addSharedFiles(root, [write('thumb.jpg', 'JPG')], fakeDeps())
    expect(res.items[0]).toMatchObject({ name: 'thumb', file: 'media.jpg', preview: 'media.jpg' })
    expect(readdirSync(join(root, res.added[0])).sort()).toEqual(['item.json', 'media.jpg'])
  })

  it('a file that has gone gives a readable reason, not a raw error', async () => {
    const res = await addSharedFiles(root, [join(src, 'gone.wav')], fakeDeps())
    expect(res.skipped).toEqual([
      { name: 'gone.wav', reason: "It couldn't be read (it may have moved, or another program has it open)." }
    ])
  })

  it('a text piece can’t be renamed to another text piece’s name (saving would replace both)', async () => {
    await saveSharedText(root, 'Bio', [makeTextLayer('A', 0, 2)])
    const list = await saveSharedText(root, 'Hook', [makeTextLayer('B', 0, 2)])
    const hook = list.find((i) => i.name === 'Hook')!
    await expect(renameShared(root, hook.id, ' bio ')).rejects.toThrow('You already have shared text called “bio”.')
    // A sound may share a text piece's name.
    const res = await addSharedFiles(root, [write('w.wav', 'W')], fakeDeps())
    expect((await renameShared(root, res.added[0], 'Bio')).filter((i) => i.name === 'Bio')).toHaveLength(2)
  })
})
