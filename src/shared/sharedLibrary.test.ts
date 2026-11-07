/**
 * The shared library's record format: which tab a file goes in, what a stored
 * record must look like (a damaged, newer, traversing or mixed-up one is
 * refused whole), a text piece keeps its layers exactly and drops like a
 * template, and the add summary says what happened.
 */
import { describe, expect, it } from 'vitest'
import { makeImageLayer, makeTextLayer } from './layers'
import { PROJECT_VERSION, type Layer } from './project'
import {
  SHARED_FORMAT_VERSION,
  describeSharedAdd,
  makeSharedText,
  migrateSharedItem,
  sanitizeSharedItem,
  sharedExtsFor,
  sharedKindOf,
  sharedTextTemplate,
  sortShared,
  type SharedItem
} from './sharedLibrary'

const fp = { size: 4, start: 'a', middle: 'b', end: 'c' }

const sound = (over: Partial<SharedItem> = {}): SharedItem => ({
  id: 'abc-123',
  name: 'Whoosh',
  kind: 'sound',
  formatVersion: SHARED_FORMAT_VERSION,
  addedAt: '2026-11-06T10:00:00.000Z',
  file: 'whoosh.wav',
  preview: null,
  durationSec: 0.4,
  fingerprint: fp,
  layers: [],
  ...over
})

/** A styled, placed, rotated, animated text layer — what a text piece must keep. */
function styledText(id: string, start: number, end: number): Layer {
  const l = makeTextLayer(id, start, end)
  return {
    ...l,
    x: 300,
    y: 1500,
    scale: 1.4,
    rotationDeg: -8,
    content: {
      ...(l.content as Extract<Layer['content'], { kind: 'text' }>),
      text: 'Link in bio',
      fontFamily: 'anton',
      color: '#ffcc00',
      animation: { in: 'bounce', inSec: 0.3, out: 'fadeOut', outSec: 0.2 }
    }
  }
}

describe('sharedKindOf / sharedExtsFor', () => {
  it('puts sounds, pictures and video on their tabs and refuses workouts', () => {
    expect(sharedKindOf('audio')).toBe('sound')
    expect(sharedKindOf('image')).toBe('graphic')
    expect(sharedKindOf('video')).toBe('video')
    expect(sharedKindOf('workout')).toBeNull()
  })
  it('offers each tab its own file types', () => {
    expect(sharedExtsFor('sound')).toContain('wav')
    expect(sharedExtsFor('graphic')).toContain('png')
    expect(sharedExtsFor('video')).toContain('mp4')
    expect(sharedExtsFor('sound')).not.toContain('png')
  })
})

describe('sanitizeSharedItem', () => {
  it('accepts a media record and a text record', () => {
    expect(sanitizeSharedItem(sound())).toEqual(sound())
    const text = makeSharedText('t-1', 'Bio', [styledText('L', 0, 2)], '2026-11-06T10:00:00.000Z')
    expect('error' in text).toBe(false)
    expect(sanitizeSharedItem(text)).toEqual(text)
  })
  it('refuses a newer format, an unknown kind, a blank name', () => {
    expect(sanitizeSharedItem(sound({ formatVersion: SHARED_FORMAT_VERSION + 1 }))).toBeNull()
    expect(sanitizeSharedItem({ ...sound(), kind: 'music' })).toBeNull()
    expect(sanitizeSharedItem(sound({ name: '   ' }))).toBeNull()
    expect(sanitizeSharedItem(null)).toBeNull()
    expect(sanitizeSharedItem('nope')).toBeNull()
  })
  it('refuses ids and file names that could leave the item folder', () => {
    expect(sanitizeSharedItem(sound({ id: '../x' }))).toBeNull()
    expect(sanitizeSharedItem(sound({ file: '..\\evil.wav' }))).toBeNull()
    expect(sanitizeSharedItem(sound({ file: 'item.json' }))).toBeNull()
    expect(sanitizeSharedItem(sound({ preview: 'a/b.jpg' }))).toBeNull()
  })
  it('refuses a media item without its file or fingerprint, or carrying layers', () => {
    expect(sanitizeSharedItem(sound({ file: null }))).toBeNull()
    expect(sanitizeSharedItem(sound({ fingerprint: null }))).toBeNull()
    expect(sanitizeSharedItem(sound({ layers: [styledText('L', 0, 1)] }))).toBeNull()
  })
  it('refuses a text piece with a file, no layers, or a non-text layer', () => {
    const base = makeSharedText('t-1', 'Bio', [styledText('L', 0, 2)], 'now') as SharedItem
    expect(sanitizeSharedItem({ ...base, file: 'x.wav' })).toBeNull()
    expect(sanitizeSharedItem({ ...base, layers: [] })).toBeNull()
    expect(sanitizeSharedItem({ ...base, layers: [makeImageLayer('I', 'logo.png', 0, 2)] })).toBeNull()
  })
})

describe('makeSharedText', () => {
  it('keeps every layer exactly as saved, its length from the layers', () => {
    const layers = [styledText('A', 0, 2), styledText('B', 0.5, 3.5)]
    const item = makeSharedText('t-1', '  Link   in bio ', layers, 'now') as SharedItem
    expect(item.name).toBe('Link in bio')
    expect(item.kind).toBe('text')
    expect(item.file).toBeNull()
    expect(item.layers).toEqual(layers)
    expect(item.durationSec).toBe(3.5)
    expect(item.projectVersion).toBe(PROJECT_VERSION)
  })
  it('needs a name and only text layers', () => {
    expect(makeSharedText('t', ' ', [styledText('A', 0, 1)], 'now')).toEqual({ error: 'Give the text a name.' })
    expect(makeSharedText('t', 'X', [makeImageLayer('I', 'logo.png', 0, 2)], 'now')).toEqual({
      error: 'Only text layers can be saved as shared text.'
    })
    expect(makeSharedText('t', 'X', [], 'now')).toHaveProperty('error')
  })
  it('drops as a template with only those layers, and stays current through migration', () => {
    const item = makeSharedText('t-1', 'Bio', [styledText('A', 0, 2)], 'now') as SharedItem
    const t = sharedTextTemplate(item)
    expect(t.layers).toBe(item.layers)
    expect(t.audio).toEqual([])
    expect(t.clipEffect).toBeNull()
    expect(migrateSharedItem(item)).toEqual(item)
    expect(migrateSharedItem(sound())).toEqual(sound())
  })
})

describe('sortShared / describeSharedAdd', () => {
  it('sorts by name, ignoring case', () => {
    const items = [
      sound({ id: 'b', name: 'pop' }),
      sound({ id: 'a', name: 'Ding' }),
      sound({ id: 'c', name: 'Whoosh' })
    ]
    expect(sortShared(items).map((i) => i.name)).toEqual(['Ding', 'pop', 'Whoosh'])
  })
  it('says what was added, what was already there and what was refused', () => {
    const items = [sound({ id: 'a', name: 'Ding' }), sound({ id: 'b', name: 'Pop' })]
    expect(describeSharedAdd({ items, added: ['a'], already: [], skipped: [] })).toBe('Added “Ding”.')
    expect(
      describeSharedAdd({
        items,
        added: ['a', 'b'],
        already: ['b'],
        skipped: [{ name: 'ride.fit', reason: 'Only sounds, pictures and video can be shared.' }]
      })
    ).toBe(
      'Added 2 files. “Pop” is already in the shared library. Not added: ride.fit. Only sounds, pictures and video can be shared.'
    )
  })
})
