import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The data dir (and with it the old global store) must point at a scratch dir
// BEFORE config resolves it.
const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'reel-legacy-'))
  process.env.VIDEO_EDITOR_DATA = join(dir, 'data')
  return dir
})
vi.mock('electron', () => ({ app: { getPath: () => scratch } }))

import {
  convertLegacyFolder,
  convertWorkingCopy,
  deleteLegacyStore,
  findLegacyReels,
  legacyStoreBytes
} from './legacyConvert'

const data = join(scratch, 'data')
const store = join(data, 'media')
const reels = join(scratch, 'Reels')
const idOf = (bytes: string): string => createHash('sha1').update(bytes).digest('hex').slice(0, 12)

/** A file + its legacy store record (+ a proxy and transcript), the way the old app left them. */
function legacyAsset(path: string, bytes: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  const id = idOf(bytes)
  mkdirSync(join(store, id), { recursive: true })
  writeFileSync(
    join(store, id, 'asset.json'),
    JSON.stringify({ id, fileName: path.split(/[\\/]/).pop(), originalPath: path, importedAt: 'x', probe: {}, proxyReady: true, transcribed: true, kind: 'video' })
  )
  writeFileSync(join(store, id, 'proxy.mp4'), `proxy of ${bytes}`)
  writeFileSync(join(store, id, 'transcript.json'), '{"words":[]}')
  return id
}

const legacyDoc = (ids: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'p', name: 'x', version: 23, preset: 'reel', layers: [], audioClips: [], mediaIds: ids, ...extra })

let inPlaceId: string, sharedId: string, nobgId: string, goneId: string
beforeAll(() => {
  // Folder project: footage beside its .reel, plus a background-removed clip.
  inPlaceId = legacyAsset(join(reels, 'bad brick', 'IMG_1.MOV'), 'brick footage')
  nobgId = legacyAsset(join(data, 'nobg', 'x.webm'), 'matte output')
  writeFileSync(join(reels, 'bad brick', 'reel.reel'), legacyDoc([inPlaceId, nobgId]))
  // Loose project using footage from another folder, one original since deleted.
  sharedId = legacyAsset(join(reels, 'bike travel', 'IMG_2.MOV'), 'bike footage')
  goneId = legacyAsset(join(scratch, 'Downloads', 'gone.mp4'), 'deleted later')
  rmSync(join(scratch, 'Downloads', 'gone.mp4'))
  writeFileSync(join(reels, 'test 2.reel'), legacyDoc([sharedId, goneId]))
  // Already converted: left alone.
  mkdirSync(join(reels, 'new one'), { recursive: true })
  writeFileSync(join(reels, 'new one', 'new one.reel'), JSON.stringify({ version: 24 }))
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

// SKIPPED ON PURPOSE (2026-10-11): this converter writes the schema-24
// hard-link layout, which the pointer model (docs/MEDIA-POINTERS.md) no longer
// opens. Both entry points (Open of an old file, File ▸ Convert old projects…)
// refuse until the converter is rewritten in phase 7, which replaces this suite.
describe.skip('legacy conversion', () => {
  it('finds legacy .reel files at the top level and one folder down, skipping converted ones', () => {
    expect(findLegacyReels(reels).sort()).toEqual([join(reels, 'bad brick', 'reel.reel'), join(reels, 'test 2.reel')].sort())
  })

  it('converts the batch: in place for a folder project, a new folder for a loose file', async () => {
    const reports = await convertLegacyFolder(reels)
    expect(reports).toHaveLength(2)

    // In place: bad brick/ becomes the project, named after its folder.
    const brick = join(reels, 'bad brick')
    const doc = JSON.parse(readFileSync(join(brick, 'bad brick.reel'), 'utf8'))
    expect(doc.version).toBe(24)
    expect(doc.name).toBe('bad brick')
    expect(existsSync(join(brick, 'reel.reel-legacy'))).toBe(true)
    expect(existsSync(join(brick, 'reel.reel'))).toBe(false)
    const original = join(brick, 'media', inPlaceId, 'original.mov')
    expect(statSync(original).ino).toBe(statSync(join(brick, 'IMG_1.MOV')).ino) // linked, not copied
    const rec = JSON.parse(readFileSync(join(brick, 'media', inPlaceId, 'asset.json'), 'utf8'))
    expect(rec).toMatchObject({ file: 'original.mov', hash: inPlaceId, storage: 'link', sourcePath: join(brick, 'IMG_1.MOV') })
    expect(rec.originalPath).toBeUndefined()
    expect(existsSync(join(brick, 'media', inPlaceId, 'transcript.json'))).toBe(true)
    expect(existsSync(join(brick, 'cache', inPlaceId, 'proxy.mp4'))).toBe(true)
    // App-generated media is adopted as generated.
    expect(JSON.parse(readFileSync(join(brick, 'media', nobgId, 'asset.json'), 'utf8'))).toMatchObject({ storage: 'generated', sourcePath: null })

    // Loose: test 2.reel → test 2/test 2.reel; the deleted original is reported missing.
    const loose = reports.find((r) => r.from.endsWith('test 2.reel'))!
    expect(loose.to).toBe(join(reels, 'test 2', 'test 2.reel'))
    expect(loose.missing).toEqual(['gone.mp4'])
    expect(loose.linked).toBe(1)
    expect(existsSync(join(reels, 'test 2.reel-legacy'))).toBe(true)
    expect(existsSync(join(reels, 'test 2', 'media', goneId, 'asset.json'))).toBe(true) // relinkable later
    expect(existsSync(join(reels, 'test 2', 'media', goneId, 'original.mp4'))).toBe(false)
  })

  it('is idempotent: a second run finds nothing left to convert', async () => {
    expect(await convertLegacyFolder(reels)).toEqual([])
  })

  it('converts the old working copy into the scratch project', async () => {
    mkdirSync(join(data, 'projects'), { recursive: true })
    writeFileSync(join(data, 'projects', 'current.json'), legacyDoc([sharedId]))
    const scratchRoot = join(data, 'projects', 'scratch')
    const report = await convertWorkingCopy(scratchRoot)
    expect(report?.linked).toBe(1)
    expect(JSON.parse(readFileSync(join(scratchRoot, 'autosave.json'), 'utf8')).mediaIds).toEqual([sharedId])
    expect(existsSync(join(data, 'projects', 'current.json.legacy'))).toBe(true)
    expect(await convertWorkingCopy(scratchRoot)).toBeNull() // done once
  })

  it('deleting the old store frees only what no project links to, and projects keep working', async () => {
    const before = await legacyStoreBytes()
    expect(before.total).toBeGreaterThan(before.freed)
    await deleteLegacyStore()
    expect(existsSync(store)).toBe(false)
    expect(existsSync(join(data, 'nobg'))).toBe(false)
    expect(readFileSync(join(reels, 'bad brick', 'media', nobgId, 'original.webm'), 'utf8')).toBe('matte output')
    expect(readFileSync(join(reels, 'bad brick', 'cache', inPlaceId, 'proxy.mp4'), 'utf8')).toBe('proxy of brick footage')
    expect(await legacyStoreBytes()).toEqual({ total: 0, freed: 0 })
  })
})
