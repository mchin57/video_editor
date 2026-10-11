import { describe, it, expect } from 'vitest'
import { unusableMessage } from './mediaHealth'

describe('unusableMessage', () => {
  it('names every missing file, and nothing that is fine', () => {
    const msg = unusableMessage([
      { fileName: 'a.mov', status: 'missing' },
      { fileName: 'b.mov', status: 'ok' },
      { fileName: 'd.mov', status: 'missing' }
    ])
    expect(msg).toContain('missing: a.mov, d.mov')
    expect(msg).toContain('Relink')
    expect(msg).not.toContain('b.mov')
  })
})
