import { describe, it, expect } from 'vitest'
import type { MediaRecord } from '@shared/media'
import { closeSession, currentSession, openSession, ProjectSession, requireSession } from './projectSession'

const record = (id: string): MediaRecord => ({
  id,
  fileName: `${id}.mov`,
  relativePath: `${id}.mov`,
  absolutePath: `/footage/${id}.mov`,
  fingerprint: { size: 1, start: 's', middle: 'm', end: 'e' },
  importedAt: '2026-01-01T00:00:00.000Z',
  probe: { durationSec: 1, container: 'mov', video: null, audio: null },
  kind: 'video'
})

describe('ProjectSession', () => {
  it('is constructible on its own, with nothing open', () => {
    const s = new ProjectSession('/p/a')
    expect(s.root).toBe('/p/a')
    expect(s.isCurrent).toBe(false)
    expect(s.library.allEntries()).toEqual([])
  })

  it('opening a project replaces and disposes the previous session; closing leaves none', () => {
    const a = openSession('/p/a')
    expect(currentSession()).toBe(a)
    const b = openSession('/p/b')
    expect(a.disposed).toBe(true)
    expect(a.isCurrent).toBe(false)
    expect(requireSession()).toBe(b)
    closeSession()
    expect(b.disposed).toBe(true)
    expect(currentSession()).toBeNull()
    expect(() => requireSession()).toThrow('No project is open.')
  })

  it('each session has its own library and flights', () => {
    const a = openSession('/p/a')
    a.library.load([record('same')])
    const b = openSession('/p/b')
    expect(b.library.getEntry('same')).toBeNull()
    expect(b.importFlight).not.toBe(a.importFlight)
    expect(b.transcribeFlight).not.toBe(a.transcribeFlight)
    a.artifactFailed.add('/p/a/cache/x/thumb.jpg')
    expect(b.artifactFailed.size).toBe(0)
  })

  it('a disposed session refuses new records; Save As moves the root and the old root is refused', () => {
    const a = openSession('/p/a')
    a.library.putEntry(record('x'), '/footage/x.mov', '/p/a') // fine while open
    a.reroot('/p/a2', (root, rel) => `${root}/${rel}`)
    expect(a.root).toBe('/p/a2')
    expect(() => a.library.putEntry(record('y'), null, '/p/a')).toThrow('The project changed')
    a.library.putEntry(record('y'), null, '/p/a2')
    openSession('/p/b')
    expect(() => a.library.putEntry(record('z'), null, '/p/a2')).toThrow('The project changed')
    closeSession()
  })
})
