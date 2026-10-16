import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaRecord } from '@shared/media'

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
vi.mock('./ffprobe', () => ({
  // Footage: a picture and sound (an .mp4 with no picture would class as audio).
  probeFile: vi.fn(async () => ({
    durationSec: 4,
    container: 'mp4',
    video: { codec: 'h264', width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, rotationDeg: 0 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2 }
  }))
}))

import { fingerprintFile } from './fingerprint'
import { documentFormat } from './projectStore'
import {
  convertLegacyFolder,
  deleteLegacyStore,
  findLegacyReels,
  legacyStoreBytes,
  remainingLegacyProjects,
  type ConversionReport
} from './legacyConvert'

const data = join(scratch, 'data')
const store = join(data, 'media')
const reels = join(scratch, 'Reels')
const idOf = (bytes: string): string => createHash('sha1').update(bytes).digest('hex').slice(0, 12)
const probe = { durationSec: 2, container: 'mov', video: null, audio: null }

/** A file + its legacy store record (+ a proxy and transcript), the way the old app left them. */
function legacyAsset(path: string, bytes: string, fileName = path.split(/[\\/]/).pop()): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  const id = idOf(bytes)
  mkdirSync(join(store, id), { recursive: true })
  writeFileSync(
    join(store, id, 'asset.json'),
    JSON.stringify({ id, fileName, originalPath: path, importedAt: 'then', probe, proxyReady: true, transcribed: true, kind: 'video' })
  )
  writeFileSync(join(store, id, 'proxy.mp4'), `proxy of ${bytes}`)
  writeFileSync(join(store, id, 'transcript.json'), `{"words":["${id}"]}`)
  return id
}

const legacyDoc = (ids: string[]): string =>
  JSON.stringify({ id: 'p', name: 'x', version: 23, preset: 'reel', layers: [], audioClips: [], mediaIds: ids })

type Saved = { version: number; name: string; mediaIds: string[]; library: MediaRecord[] }
const readDoc = (path: string): Saved => JSON.parse(readFileSync(path, 'utf8')) as Saved
const recordOf = (doc: Saved, id: string): MediaRecord => doc.library.find((r) => r.id === id)!

const brick = join(reels, 'bad brick')
let reports: ConversionReport[] = []
const footage = join(brick, 'IMG_1.MOV')
let footageStat: { size: number; mtimeMs: number }
let brickId: string, nobgId: string, sharedId: string, goneId: string, movedId: string, orphanId: string
beforeAll(() => {
  // Folder project: footage beside its .reel, plus a background-removed clip
  // whose display name isn't a legal file name.
  brickId = legacyAsset(footage, 'brick footage')
  nobgId = legacyAsset(join(data, 'nobg', 'x.webm'), 'matte output', 'IMG_1 (no bg 0:03–0:05).webm')
  writeFileSync(join(brick, 'reel.reel'), legacyDoc([brickId, nobgId]))
  const s = statSync(footage)
  footageStat = { size: s.size, mtimeMs: s.mtimeMs }
  // Loose project using footage from another folder, one original since deleted.
  sharedId = legacyAsset(join(scratch, 'Footage', 'IMG_2.MOV'), 'bike footage')
  goneId = legacyAsset(join(scratch, 'Downloads', 'gone.mp4'), 'deleted later')
  rmSync(join(scratch, 'Downloads', 'gone.mp4'))
  writeFileSync(join(reels, 'test 2.reel'), legacyDoc([sharedId, goneId]))
  // Footage moved (and renamed) next to its project after import; plus a clip
  // whose store record is gone but whose file sits beside the .reel, and one
  // with neither.
  movedId = legacyAsset(join(scratch, 'Downloads', 'IMG_3.MOV'), 'moved footage')
  rmSync(join(scratch, 'Downloads', 'IMG_3.MOV'))
  mkdirSync(join(reels, 'moved'), { recursive: true })
  writeFileSync(join(reels, 'moved', 'renamed.mov'), 'moved footage')
  writeFileSync(join(reels, 'moved', 'orphan.mp4'), 'orphan footage')
  orphanId = idOf('orphan footage')
  writeFileSync(join(reels, 'moved', 'notes.txt'), 'not media')
  writeFileSync(join(reels, 'moved', 'cut.reel'), legacyDoc([movedId, orphanId, 'eeeeeeeeeeee']))
  // Already converted: left alone.
  mkdirSync(join(reels, 'new one'), { recursive: true })
  writeFileSync(join(reels, 'new one', 'new one.reel'), JSON.stringify({ version: 25 }))
  // A second folder the app looks in, not part of this batch.
  mkdirSync(join(scratch, 'Elsewhere'), { recursive: true })
  writeFileSync(join(scratch, 'Elsewhere', 'other.reel'), legacyDoc([sharedId]))
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('legacy conversion', () => {
  it('finds legacy .reel files at the top level and one folder down, skipping converted ones', () => {
    expect(findLegacyReels(reels).sort()).toEqual(
      [join(brick, 'reel.reel'), join(reels, 'moved', 'cut.reel'), join(reels, 'test 2.reel')].sort()
    )
  })

  it('converts the batch: a folder project in place, its records pointing at the footage', async () => {
    reports = await convertLegacyFolder(reels)
    expect(reports).toHaveLength(3)
    expect(reports.every((r) => !r.error)).toBe(true)

    const doc = readDoc(join(brick, 'bad brick.reel'))
    expect(documentFormat(doc)).toBe('current')
    expect(doc.name).toBe('bad brick')
    expect(doc.mediaIds).toEqual([brickId, nobgId])
    expect(existsSync(join(brick, 'reel.reel-legacy'))).toBe(true)
    expect(existsSync(join(brick, 'reel.reel'))).toBe(false)

    const rec = recordOf(doc, brickId)
    expect(rec).toMatchObject({ fileName: 'IMG_1.MOV', relativePath: 'IMG_1.MOV', absolutePath: footage, importedAt: 'then', kind: 'video' })
    expect(rec.fingerprint).toEqual(await fingerprintFile(footage))
    expect(rec.generated).toBeUndefined()
    // The footage itself is untouched: same bytes, same time, not linked.
    const after = statSync(footage)
    expect({ size: after.size, mtimeMs: after.mtimeMs, nlink: after.nlink }).toEqual({ ...footageStat, nlink: 1 })
    expect(readFileSync(join(brick, 'transcripts', `${brickId}.json`), 'utf8')).toContain(brickId)
    expect(readFileSync(join(brick, 'cache', brickId, 'proxy.mp4'), 'utf8')).toBe('proxy of brick footage')
  })

  it('copies generated media into generated/ under a legal name', () => {
    const doc = readDoc(join(brick, 'bad brick.reel'))
    const gen = join(brick, 'generated', 'IMG_1 (no bg 0.03–0.05).webm')
    expect(readFileSync(gen, 'utf8')).toBe('matte output')
    expect(recordOf(doc, nobgId)).toMatchObject({
      generated: true,
      fileName: 'IMG_1 (no bg 0:03–0:05).webm',
      absolutePath: gen,
      relativePath: 'generated/IMG_1 (no bg 0.03–0.05).webm'
    })
  })

  it('gives a loose file its own folder and records a deleted original as missing', async () => {
    const doc = readDoc(join(reels, 'test 2', 'test 2.reel'))
    expect(existsSync(join(reels, 'test 2.reel-legacy'))).toBe(true)
    expect(recordOf(doc, sharedId)).toMatchObject({
      absolutePath: join(scratch, 'Footage', 'IMG_2.MOV'),
      relativePath: '../../Footage/IMG_2.MOV'
    })
    const gone = recordOf(doc, goneId)
    expect(gone.fingerprint.size).toBe(-1)
    expect(gone.absolutePath).toBe(join(scratch, 'Downloads', 'gone.mp4'))
    expect(existsSync(join(reels, 'test 2', 'transcripts', `${goneId}.json`))).toBe(true) // kept for a relink
  })

  it('finds footage moved beside the .reel, and recovers a clip the store lost', async () => {
    const doc = readDoc(join(reels, 'moved', 'moved.reel'))
    expect(recordOf(doc, movedId)).toMatchObject({ fileName: 'IMG_3.MOV', relativePath: 'renamed.mov', absolutePath: join(reels, 'moved', 'renamed.mov') })
    expect(recordOf(doc, orphanId)).toMatchObject({ fileName: 'orphan.mp4', relativePath: 'orphan.mp4', kind: 'video' })
    expect(recordOf(doc, orphanId).probe.durationSec).toBe(4)
    expect(doc.library).toHaveLength(2)
    expect(doc.mediaIds).toContain('eeeeeeeeeeee') // nothing to build a record from: left as is
  })

  it('reports what it found, copied and missed', () => {
    const by = (name: string): ConversionReport => reports.find((r) => r.from.includes(name))!
    expect(by('bad brick')).toMatchObject({ to: join(brick, 'bad brick.reel'), found: 2, copied: 1, missing: [] })
    expect(by('test 2')).toMatchObject({ to: join(reels, 'test 2', 'test 2.reel'), found: 1, copied: 0, missing: ['gone.mp4'] })
    expect(by('moved')).toMatchObject({ found: 2, copied: 0, missing: ['1 clip with no record in the old library'] })
  })

  it('is idempotent: a second run finds nothing left to convert', async () => {
    expect(await convertLegacyFolder(reels)).toEqual([])
  })

  it('knows legacy projects remain elsewhere until they are converted too', async () => {
    const elsewhere = join(scratch, 'Elsewhere')
    expect(remainingLegacyProjects([reels, elsewhere, elsewhere.toUpperCase()])).toEqual([join(elsewhere, 'other.reel')])
    const [report] = await convertLegacyFolder(elsewhere)
    expect(report).toMatchObject({ found: 1, copied: 0, missing: [], to: join(elsewhere, 'other', 'other.reel') })
    expect(remainingLegacyProjects([reels, elsewhere])).toEqual([])
  })

  it('deleting the old store frees only what no project links to, and projects keep working', async () => {
    const before = await legacyStoreBytes()
    expect(before.total).toBeGreaterThan(before.freed)
    await deleteLegacyStore()
    expect(existsSync(store)).toBe(false)
    expect(existsSync(join(data, 'nobg'))).toBe(false)
    expect(readFileSync(join(brick, 'generated', 'IMG_1 (no bg 0.03–0.05).webm'), 'utf8')).toBe('matte output')
    expect(readFileSync(join(brick, 'cache', brickId, 'proxy.mp4'), 'utf8')).toBe('proxy of brick footage')
    expect(await legacyStoreBytes()).toEqual({ total: 0, freed: 0 })
  })
})
