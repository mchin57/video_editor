import { describe, it, expect } from 'vitest'
import { hashVerdict, statVerdict, unusableMessage } from './mediaHealth'

describe('statVerdict', () => {
  const rec = { size: 100, mtimeMs: 5 }

  it('trusts an unchanged stamp without hashing', () => {
    expect(statVerdict(rec, { size: 100, mtimeMs: 5 })).toBe('ok')
  })

  it('flags a vanished original as missing', () => {
    expect(statVerdict(rec, null)).toBe('missing')
  })

  it('re-hashes on any size or mtime difference', () => {
    expect(statVerdict(rec, { size: 101, mtimeMs: 5 })).toBe('rehash')
    expect(statVerdict(rec, { size: 100, mtimeMs: 6 })).toBe('rehash')
  })

  it('re-hashes a record that predates stamps', () => {
    expect(statVerdict({}, { size: 100, mtimeMs: 5 })).toBe('rehash')
  })
})

describe('hashVerdict', () => {
  it('re-stamps a touched file whose bytes are identical', () => {
    expect(hashVerdict('abc', 'abc')).toBe('restamp')
  })
  it('calls different bytes changed', () => {
    expect(hashVerdict('abc', 'abd')).toBe('changed')
  })
})

describe('unusableMessage', () => {
  it('names every missing and changed file, and nothing that is fine', () => {
    const msg = unusableMessage([
      { fileName: 'a.mov', status: 'missing' },
      { fileName: 'b.mov', status: 'ok' },
      { fileName: 'c.mov', status: 'changed' },
      { fileName: 'd.mov', status: 'missing' }
    ])
    expect(msg).toContain('missing: a.mov, d.mov')
    expect(msg).toContain('changed outside the app: c.mov')
    expect(msg).not.toContain('b.mov')
  })
})
