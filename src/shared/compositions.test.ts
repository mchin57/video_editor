import { describe, it, expect } from 'vitest'
import type { Composition, Layer, LayoutCell, Project } from './project'
import { createEmptyComposition, createEmptyProject, referencedMediaIds } from './project'
import { makeVideoLayer } from './layers'
import {
  MAX_COMP_DEPTH,
  compDepth,
  compositionDuration,
  makeCompFromCell,
  makeCompFromLayer,
  resolveCompAtPath,
  stepInto,
  updateCompAtPath
} from './compositions'

let n = 0
const makeId = (): string => `id-${n++}`

const audio = (mediaId: string, startSec: number, inSec: number, outSec: number) => ({
  id: makeId(),
  mediaId,
  startSec,
  inSec,
  outSec,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'music' as const
})

/** A comp holding one video layer over [0, dur). */
const clipComp = (mediaId: string, dur: number): Composition => ({
  ...createEmptyComposition(),
  layers: [makeVideoLayer(makeId(), mediaId, 0, dur)]
})

/** A compound layer wrapping `comp` over the given parent window. */
const compoundLayer = (id: string, comp: Composition, startSec: number, endSec: number): Layer => ({
  id,
  hidden: false,
  startSec,
  endSec,
  x: 540,
  y: 960,
  scale: 1,
  content: { kind: 'compound', comp }
})

/** A one-cell layout layer whose cell carries `comp` (or a plain clip). */
const layoutLayer = (id: string, cell: Partial<LayoutCell>): Layer => ({
  id,
  hidden: false,
  startSec: 0,
  endSec: 5,
  x: 540,
  y: 960,
  scale: 1,
  content: {
    kind: 'layout',
    presetId: 'split-lr',
    cells: [
      {
        mediaId: null,
        inSec: 0,
        outSec: 5,
        mute: true,
        rect: { x: 0, y: 0, w: 540, h: 1920 },
        ...cell
      }
    ]
  }
})

/** Root project: a compound layer 'cmp' whose comp contains a layout 'lay'
 *  whose cell 0 carries a comp with one clip — depth 3. */
function nestedRoot(): Project {
  const inner = clipComp('m-inner', 4)
  const mid: Composition = {
    ...createEmptyComposition(),
    layers: [layoutLayer('lay', { comp: inner })]
  }
  const root = createEmptyProject('p', 'test')
  root.layers = [compoundLayer('cmp', mid, 1, 6)]
  return root
}

describe('stepInto / resolveCompAtPath', () => {
  it('resolves compound-layer and layout-cell steps, empty path = root', () => {
    const root = nestedRoot()
    expect(resolveCompAtPath(root, [])).toBe(root)
    const mid = resolveCompAtPath(root, [{ layerId: 'cmp' }])
    expect(mid?.layers[0].id).toBe('lay')
    const inner = resolveCompAtPath(root, [{ layerId: 'cmp' }, { layerId: 'lay', cellIndex: 0 }])
    expect(inner?.layers[0].content.kind).toBe('video')
  })

  it('returns null for missing layers, wrong kinds, and single-clip cells', () => {
    const root = nestedRoot()
    expect(resolveCompAtPath(root, [{ layerId: 'nope' }])).toBeNull()
    expect(resolveCompAtPath(root, [{ layerId: 'cmp', cellIndex: 0 }])).toBeNull() // compound, not layout
    const simple = createEmptyProject('p2', 't')
    simple.layers = [layoutLayer('lay', { mediaId: 'm' })]
    expect(stepInto(simple, { layerId: 'lay', cellIndex: 0 })).toBeNull() // no comp on the cell
  })
})

describe('updateCompAtPath', () => {
  it('applies fn at depth, rebuilding ancestors immutably', () => {
    const root = nestedRoot()
    const path = [{ layerId: 'cmp' }, { layerId: 'lay', cellIndex: 0 as const }]
    const next = updateCompAtPath(root, path, (comp) => ({ ...comp, layers: [] }))
    expect(resolveCompAtPath(next, path)?.layers).toHaveLength(0)
    // The original tree is untouched (immutability).
    expect(resolveCompAtPath(root, path)?.layers).toHaveLength(1)
    // Root identity fields survive the spread.
    expect(next.id).toBe(root.id)
    expect(next.version).toBe(root.version)
  })

  it('the empty path edits the root document itself', () => {
    const root = nestedRoot()
    const next = updateCompAtPath(root, [], (comp) => ({ ...comp, audioClips: [audio('a', 0, 0, 3)] }))
    expect(next.audioClips).toHaveLength(1)
    expect(next.layers).toBe(root.layers) // untouched slices keep identity
  })

  it('a stale path is a safe no-op', () => {
    const root = nestedRoot()
    const next = updateCompAtPath(root, [{ layerId: 'gone' }], (comp) => ({ ...comp, layers: [] }))
    expect(next.layers).toEqual(root.layers)
  })
})

describe('compositionDuration', () => {
  it('is the furthest visual or audio end', () => {
    const comp = clipComp('m', 4)
    expect(compositionDuration(comp)).toBe(4)
    comp.audioClips.push(audio('a', 2, 0, 5)) // ends at 7
    expect(compositionDuration(comp)).toBe(7)
  })
  it('whole-source audio (outSec<=0) resolves via srcDur', () => {
    const comp = { ...createEmptyComposition(), audioClips: [audio('a', 1, 0, 0)] }
    expect(compositionDuration(comp, () => 6)).toBe(7)
  })
})

describe('compDepth', () => {
  it('counts the deepest nesting chain (root = 1)', () => {
    expect(compDepth(createEmptyComposition())).toBe(1)
    const root = nestedRoot()
    expect(compDepth(root)).toBe(3)
    expect(MAX_COMP_DEPTH).toBeGreaterThanOrEqual(3)
  })
})

describe('makeCompFromCell / makeCompFromLayer', () => {
  it('seeds a comp from a single-clip cell keeping trim and mute', () => {
    const comp = makeCompFromCell({ mediaId: 'm', inSec: 2, outSec: 7, mute: false }, makeId)
    expect(comp.layers).toHaveLength(1)
    const l = comp.layers[0]
    expect(l.startSec).toBe(0)
    expect(l.endSec).toBe(5)
    expect(l.content).toMatchObject({ kind: 'video', mediaId: 'm', inSec: 2, outSec: 7, mute: false })
  })
  it('an empty cell yields an empty comp', () => {
    expect(makeCompFromCell({ mediaId: null, inSec: 0, outSec: 5, mute: true }, makeId).layers).toHaveLength(0)
  })
  it('zero-bases a timeline layer and drops its link group', () => {
    const src = { ...makeVideoLayer('v', 'm', 3, 4), linkGroupId: 'g1' }
    const comp = makeCompFromLayer(src)
    expect(comp.layers[0].startSec).toBe(0)
    expect(comp.layers[0].endSec).toBe(4)
    expect(comp.layers[0].linkGroupId).toBeUndefined()
    expect(comp.layers[0].content).toBe(src.content) // content carried as-is
  })
})

describe('referencedMediaIds recursion', () => {
  it('collects media through compound layers and cell comps', () => {
    const root = nestedRoot() // inner clip m-inner behind two levels
    root.audioClips = [audio('m-root-audio', 0, 0, 3)]
    expect(referencedMediaIds(root).sort()).toEqual(['m-inner', 'm-root-audio'])
  })
  it('a cell comp OVERRIDES the cell mediaId (not double-counted)', () => {
    const p = createEmptyProject('p', 't')
    p.layers = [layoutLayer('lay', { mediaId: 'm-old', comp: clipComp('m-new', 2) })]
    expect(referencedMediaIds(p)).toEqual(['m-new'])
  })
})
