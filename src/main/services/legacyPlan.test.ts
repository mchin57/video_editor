import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  adoptAction,
  conversionFolder,
  isGeneratedPath,
  isLegacyDoc,
  legacyBackupPath,
  legacyIdsIn,
  reportLine
} from './legacyPlan'

const reels = join('C:', 'Reels')

describe('isLegacyDoc', () => {
  it('treats anything before v24 (or unversioned) as legacy', () => {
    expect(isLegacyDoc({ version: 23 })).toBe(true)
    expect(isLegacyDoc({})).toBe(true)
    expect(isLegacyDoc({ version: 24 })).toBe(false)
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
})

describe('adopting legacy media', () => {
  const data = join('C:', 'Users', 'me', 'Documents', 'VideoEditor')

  it('picks out the store ids a document mentions', () => {
    const doc = JSON.stringify({ mediaIds: ['aaaaaaaaaaaa'], layers: [{ content: { mediaId: 'bbbbbbbbbbbb' } }] })
    expect(legacyIdsIn(doc, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'not-an-id'])).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb'
    ])
  })

  it('tells app-generated originals from the user’s footage', () => {
    expect(isGeneratedPath(join(data, 'nobg', 'x.webm'), data)).toBe(true)
    expect(isGeneratedPath(join('c:', 'users', 'me', 'documents', 'videoeditor', 'stills', 'y.png'), data)).toBe(true)
    expect(isGeneratedPath(join(reels, 'IMG_1.MOV'), data)).toBe(false)
  })

  it('adopts only an original that still exists with its import-time bytes', () => {
    const src = join(reels, 'IMG_1.MOV')
    expect(adoptAction(src, { exists: true, hash: 'abc' }, 'abc', data)).toEqual({ kind: 'adopt', from: src, generated: false })
    expect(adoptAction(src, { exists: false, hash: null }, 'abc', data)).toEqual({ kind: 'missing', reason: 'gone' })
    expect(adoptAction(src, { exists: true, hash: 'zzz' }, 'abc', data)).toEqual({ kind: 'missing', reason: 'different' })
  })
})

describe('reporting', () => {
  it('keeps the legacy file beside the new one, out of the .reel filter', () => {
    expect(legacyBackupPath(join(reels, 'x', 'save.reel'))).toBe(join(reels, 'x', 'save.reel-legacy'))
  })

  it('summarises each project in one line', () => {
    const base = { from: join(reels, 'sick', 'project.reel'), to: 'x', linked: 3, copied: 1, missing: [] as string[] }
    expect(reportLine(base)).toBe('✓ project: 4 files (1 copied)')
    expect(reportLine({ ...base, missing: ['IMG_9.MOV'] })).toBe('! project: 4 files (1 copied), missing IMG_9.MOV')
    expect(reportLine({ ...base, error: 'bad JSON' })).toBe('✗ project: bad JSON')
  })
})
