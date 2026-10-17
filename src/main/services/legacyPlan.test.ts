import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  conversionFolder,
  generatedFileName,
  idsToConvert,
  isGeneratedPath,
  isLegacyDoc,
  isSharedDir,
  legacyBackupPath,
  legacyIdsIn,
  nearbyOrder,
  noRecordLine,
  reportLine
} from './legacyPlan'

const reels = join('C:', 'Reels')

describe('isLegacyDoc', () => {
  it('treats anything before v24 (or unversioned) as legacy', () => {
    expect(isLegacyDoc({ version: 23 })).toBe(true)
    expect(isLegacyDoc({})).toBe(true)
    expect(isLegacyDoc({ version: 24 })).toBe(false)
    expect(isLegacyDoc({ version: 25 })).toBe(false)
  })
})

describe('conversionFolder', () => {
  const none = { taken: () => false }

  it('converts a .reel alone in its own folder in place', () => {
    const path = join(reels, 'bad brick', 'reel.reel')
    expect(conversionFolder(path, { ...none, reelsInDir: 1, dirIsShared: false })).toEqual({
      root: join(reels, 'bad brick'),
      inPlace: true
    })
  })

  it('gives a loose file (batch root) its own new folder', () => {
    const path = join(reels, 'test 2.reel')
    expect(conversionFolder(path, { ...none, reelsInDir: 1, dirIsShared: true }).root).toBe(join(reels, 'test 2'))
  })

  it('gives each of several files in one folder its own folder', () => {
    const path = join(reels, 'trip', 'cut A.reel')
    expect(conversionFolder(path, { ...none, reelsInDir: 2, dirIsShared: false })).toEqual({
      root: join(reels, 'trip', 'cut A'),
      inPlace: false
    })
  })

  it('never merges into an existing folder', () => {
    const taken = new Set([join(reels, 'test 2'), join(reels, 'test 2 (2)')])
    const path = join(reels, 'test 2.reel')
    expect(conversionFolder(path, { reelsInDir: 3, dirIsShared: true, taken: (f) => taken.has(f) }).root).toBe(
      join(reels, 'test 2 (3)')
    )
  })

  it('recognises a shared folder whatever its case or trailing separator', () => {
    const docs = join('C:', 'Users', 'me', 'Documents')
    expect(isSharedDir(join('c:', 'users', 'ME', 'documents') + '\\', [docs])).toBe(true)
    expect(isSharedDir(join(docs, 'Reels'), [docs, ''])).toBe(false)
  })
})

describe('which media to convert', () => {
  const data = join('C:', 'Users', 'me', 'Documents', 'VideoEditor')

  it('picks out the store ids a document mentions', () => {
    const doc = JSON.stringify({ mediaIds: ['aaaaaaaaaaaa'], layers: [{ content: { mediaId: 'bbbbbbbbbbbb' } }] })
    expect(legacyIdsIn(doc, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'not-an-id'])).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb'
    ])
  })

  it('adds the document’s own mediaIds that the store lost, once each', () => {
    const doc = JSON.stringify({ mediaIds: ['aaaaaaaaaaaa', 'dddddddddddd', 'junk'] })
    expect(idsToConvert(doc, ['aaaaaaaaaaaa'], ['aaaaaaaaaaaa', 'dddddddddddd', 'junk', 7])).toEqual([
      'aaaaaaaaaaaa',
      'dddddddddddd'
    ])
    expect(idsToConvert(doc, [], undefined)).toEqual([])
  })

  it('tells app-generated originals from the user’s footage', () => {
    expect(isGeneratedPath(join(data, 'nobg', 'x.webm'), data)).toBe(true)
    expect(isGeneratedPath(join('c:', 'users', 'me', 'documents', 'videoeditor', 'stills', 'y.png'), data)).toBe(true)
    expect(isGeneratedPath(join(reels, 'IMG_1.MOV'), data)).toBe(false)
  })

  it('names a generated copy with its real extension', () => {
    expect(generatedFileName('clip (no bg 0.03–0.05).webm', 'x/abc.webm')).toBe('clip (no bg 0.03–0.05).webm')
    expect(generatedFileName('clip (no bg)', 'x/abc.WEBM')).toBe('clip (no bg).webm')
  })

  it('hashes a nearby file named like the record first', () => {
    const files = [join(reels, 'a.mov'), join(reels, 'IMG_1.MOV'), join(reels, 'z.mov')]
    expect(nearbyOrder(files, 'img_1.mov')).toEqual([
      join(reels, 'IMG_1.MOV'),
      join(reels, 'a.mov'),
      join(reels, 'z.mov')
    ])
    expect(nearbyOrder(files, undefined)).toEqual(files)
  })
})

describe('reporting', () => {
  it('keeps the legacy file beside the new one, out of the .reel filter', () => {
    expect(legacyBackupPath(join(reels, 'x', 'save.reel'))).toBe(join(reels, 'x', 'save.reel-legacy'))
  })

  it('summarises each project in one line', () => {
    const base = { from: join(reels, 'sick', 'project.reel'), to: 'x', found: 4, copied: 1, missing: [] as string[] }
    expect(reportLine(base)).toBe('✓ project: 4 files found (1 copied)')
    expect(reportLine({ ...base, found: 1, copied: 0 })).toBe('✓ project: 1 file found')
    expect(reportLine({ ...base, missing: ['IMG_9.MOV', noRecordLine(2)] })).toBe(
      '! project: 4 files found (1 copied), missing IMG_9.MOV, 2 clips with no record in the old library'
    )
    expect(reportLine({ ...base, error: 'bad JSON' })).toBe('✗ project: bad JSON')
    expect(noRecordLine(1)).toBe('1 clip with no record in the old library')
  })
})
