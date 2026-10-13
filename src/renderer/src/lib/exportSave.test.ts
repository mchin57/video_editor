import { describe, it, expect } from 'vitest'
import { exportSaveSkipReason } from './exportSave'

describe('exportSaveSkipReason', () => {
  const open = (id: string, filePath: string | null = `C:/Reels/${id}/${id}.reel`) => ({ project: { id }, filePath })

  it('saves when the project the export came from is still open', () => {
    expect(exportSaveSkipReason({ id: 'a', filePath: 'C:/Reels/a/a.reel' }, open('a'))).toBeNull()
    expect(exportSaveSkipReason({ id: 'a' }, open('a'))).toBeNull() // id only (the assistant)
  })

  it('does not save another project opened while it exported', () => {
    expect(exportSaveSkipReason({ id: 'a', filePath: 'C:/Reels/a/a.reel' }, open('b'))).toMatch(/Another project was opened/)
    expect(exportSaveSkipReason({ id: 'a' }, open('b'))).toMatch(/Another project was opened/)
  })

  it('does not save the same document now at another file (e.g. a copy sharing its id)', () => {
    expect(exportSaveSkipReason({ id: 'a', filePath: 'C:/Reels/a/a.reel' }, open('a', 'C:/Reels/copy/copy.reel'))).toMatch(
      /Another project/
    )
  })

  it('does not save when no project is open any more', () => {
    expect(exportSaveSkipReason({ id: 'a' }, { project: null, filePath: null })).toMatch(/closed/)
  })
})
