import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../project'
import { makeTextLayer } from '../layers'
import { describeUndo, undoChanges } from './undoSummary'

// One template, so createdAt is identical in every copy.
const template = { ...createEmptyProject('p', 'P'), mediaIds: ['m1'] }
const base = () => structuredClone(template)
const name = (id: string): string => `${id}.mp4`

describe('undoChanges / describeUndo', () => {
  // #16: undoing an import/trim/split removed library clips while the reply
  // showed only the unchanged timeline and `undone: true`.
  it('names library clips an undo took out, with an unchanged timeline', () => {
    const before = { ...base(), mediaIds: ['m1', 'm2', 'm3'] }
    const c = undoChanges(before, base())
    expect(c.library).toEqual({ removed: ['m2', 'm3'], restored: [] })
    expect(c.layers).toEqual({ removed: [], restored: [], changed: [] })
    expect(describeUndo(c, name)).toBe('Undid: removed 2 clips from the library (m2.mp4, m3.mp4).')
  })

  it('reports timeline layers removed, restored and changed', () => {
    const t = makeTextLayer('t1', 0, 2)
    const after = { ...base(), layers: [t, makeTextLayer('t2', 0, 2)] }
    const before = { ...base(), layers: [{ ...t, endSec: 5 }, makeTextLayer('t3', 0, 1)] }
    const c = undoChanges(before, after)
    expect(c.layers).toEqual({ removed: ['t3'], restored: ['t2'], changed: ['t1'] })
    expect(describeUndo(c, name)).toBe(
      'Undid: removed 1 layer from the timeline; restored 1 layer on the timeline; reverted changes to 1 layer.'
    )
  })

  it('reports captions and other settings, ignoring updatedAt', () => {
    const after = base()
    const before = {
      ...after,
      updatedAt: 'later',
      preset: 'square' as const,
      captions: { ...after.captions, enabled: !after.captions.enabled }
    }
    const c = undoChanges(before, after)
    expect(c.captionsChanged).toBe(true)
    expect(c.otherChanged).toBe(true)
    expect(undoChanges({ ...after, updatedAt: 'later' }, after).otherChanged).toBe(false)
    expect(describeUndo(c, name)).toBe('Undid: reverted the captions; reverted project settings.')
  })

  it('says so when nothing visible changed', () => {
    expect(describeUndo(undoChanges(base(), base()), name)).toBe('Undid a step that changed nothing visible.')
  })
})
