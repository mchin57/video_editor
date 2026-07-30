/**
 * Link-group behavior (the promises the timeline's Link / Unlink make):
 * selection is all-or-nothing, movement is a shared delta that preserves every
 * relative offset, a split happens at the playhead per member (and only where
 * the playhead actually lands), and deletion takes the group.
 */
import { describe, it, expect } from 'vitest'
import {
  canLinkItems,
  canSplitItems,
  canUnlinkItems,
  expandGroup,
  expandSelection,
  linkItems,
  moveItemsBy,
  pruneLinkGroups,
  removeItems,
  splitItemsAt,
  splittableAt,
  timelineTiles,
  unlinkItems
} from './links'
import { makeLayoutLayer } from '@shared/layouts'
import { makeVideoLayer } from '@shared/layers'
import { createEmptyProject } from '@shared/project'
import type {
  AudioClip,
  CaptionSegment,
  Layer,
  Project,
  TimelineItemRef,
  VideoContent
} from '@shared/project'

const L = (id: string): TimelineItemRef => ({ kind: 'layer', id })
const A = (id: string): TimelineItemRef => ({ kind: 'audio', id })
const C = (id: string): TimelineItemRef => ({ kind: 'caption', id })

/** A video layer starting at `startSec`, `dur` seconds long. */
function layer(id: string, startSec: number, dur: number, gid?: string): Layer {
  const l = makeVideoLayer(id, `media-${id}`, startSec, dur)
  return gid ? { ...l, linkGroupId: gid } : l
}

function audio(id: string, startSec: number, dur: number, gid?: string): AudioClip {
  return {
    id,
    mediaId: `media-${id}`,
    startSec,
    inSec: 0,
    outSec: dur,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    kind: 'music',
    ...(gid ? { linkGroupId: gid } : {})
  }
}

function caption(id: string, startSec: number, dur: number, gid?: string): CaptionSegment {
  return {
    id,
    startSec,
    endSec: startSec + dur,
    text: id,
    words: [],
    enabled: true,
    ...(gid ? { linkGroupId: gid } : {})
  }
}

/** A project holding the given tiles (captions enabled so segments count). */
function project(parts: {
  layers?: Layer[]
  audioClips?: AudioClip[]
  segments?: CaptionSegment[]
}): Project {
  const p = createEmptyProject('p', 'test')
  return {
    ...p,
    layers: parts.layers ?? [],
    audioClips: parts.audioClips ?? [],
    captions: { ...p.captions, enabled: true, segments: parts.segments ?? [] }
  }
}

/** Deterministic id generator so assertions can name the new pieces. */
function ids(prefix = 'new'): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}

/** A clip + its (offset) audio, linked as group `g1`. */
const pair = (): Project =>
  project({
    layers: [layer('L1', 0, 10, 'g1')],
    audioClips: [audio('A1', 2, 6, 'g1')]
  })

const startOf = (p: Project, ref: TimelineItemRef): number =>
  timelineTiles(p).find((t) => t.ref.kind === ref.kind && t.ref.id === ref.id)!.startSec

describe('link / unlink', () => {
  it('links two tiles across lanes into one group', () => {
    const p = project({ layers: [layer('L1', 0, 10)], audioClips: [audio('A1', 2, 6)] })
    const next = linkItems(p, [L('L1'), A('A1')], ids('g'))
    expect(next.layers[0].linkGroupId).toBe('g0')
    expect(next.audioClips[0].linkGroupId).toBe('g0')
  })

  it('refuses to link fewer than two linkable tiles, and never links a layout', () => {
    const p = project({ layers: [layer('L1', 0, 10), makeLayoutLayer('LO', '2-portrait', 0)] })
    expect(linkItems(p, [L('L1')], ids())).toBe(p) // single tile
    expect(linkItems(p, [L('L1'), L('LO')], ids())).toBe(p) // the layout doesn't count
    expect(canLinkItems(p, [L('L1'), L('LO')])).toBe(false)
  })

  it('absorbs an existing group whole, so partners are never torn apart', () => {
    // L1+A1 are already linked; linking L1 with L2 must bring A1 along.
    const p = project({
      layers: [layer('L1', 0, 10, 'g1'), layer('L2', 20, 5)],
      audioClips: [audio('A1', 2, 6, 'g1')]
    })
    const next = linkItems(p, [L('L1'), L('L2')], ids('g'))
    const gid = next.layers[0].linkGroupId
    expect(gid).toBe('g0')
    expect(next.layers[1].linkGroupId).toBe(gid)
    expect(next.audioClips[0].linkGroupId).toBe(gid)
  })

  it('re-linking exactly one existing group is a no-op', () => {
    const p = pair()
    expect(canLinkItems(p, [L('L1'), A('A1')])).toBe(false)
    expect(linkItems(p, [L('L1'), A('A1')], ids())).toBe(p)
  })

  it('unlinks the whole group from any one member', () => {
    const p = pair()
    expect(canUnlinkItems(p, [A('A1')])).toBe(true)
    const next = unlinkItems(p, [A('A1')])
    expect(next.layers[0].linkGroupId).toBeUndefined()
    expect(next.audioClips[0].linkGroupId).toBeUndefined()
    expect(canUnlinkItems(next, [L('L1'), A('A1')])).toBe(false)
    expect(unlinkItems(next, [L('L1')])).toBe(next) // nothing to do
  })

  it('treats a single-member group as unlinked and prunes it', () => {
    const p = project({ layers: [layer('L1', 0, 10, 'ghost')] })
    expect(expandGroup(p, L('L1'))).toEqual([L('L1')])
    expect(canUnlinkItems(p, [L('L1')])).toBe(false)
    expect(pruneLinkGroups(p).layers[0].linkGroupId).toBeUndefined()
  })
})

describe('selection expansion', () => {
  it('grows one member to the whole group, in document order', () => {
    expect(expandGroup(pair(), A('A1'))).toEqual([L('L1'), A('A1')])
  })

  it('leaves an unlinked tile alone and drops refs that no longer exist', () => {
    const p = project({ layers: [layer('L1', 0, 10)] })
    expect(expandGroup(p, L('L1'))).toEqual([L('L1')])
    expect(expandGroup(p, L('gone'))).toEqual([])
  })

  it('dedupes when several members of one group are selected', () => {
    expect(expandSelection(pair(), [A('A1'), L('L1'), A('A1')])).toEqual([L('L1'), A('A1')])
  })
})

describe('moveItemsBy', () => {
  it('keeps the offset between members and each tile’s own duration', () => {
    // L1 at 0 (10s long), A1 at 2 (6s) → 2s offset, 4s length difference.
    const next = moveItemsBy(pair(), [L('L1'), A('A1')], 5)
    expect(next.layers[0].startSec).toBe(5)
    expect(next.layers[0].endSec).toBe(15) // still 10s
    expect(next.audioClips[0].startSec).toBe(7) // still 2s after the layer
    expect(next.audioClips[0].outSec).toBe(6) // trim untouched
  })

  it('clamps the whole group on the earliest member instead of squashing it', () => {
    // Dragging 10s left: L1 (at 0) can only give 0, so nothing moves.
    const p = pair()
    expect(moveItemsBy(p, [L('L1'), A('A1')], -10)).toBe(p)
    // From 4/6, a -6 drag stops when L1 hits 0 and A1 keeps its 2s offset.
    const shifted = moveItemsBy(p, [L('L1'), A('A1')], 4)
    const next = moveItemsBy(shifted, [L('L1'), A('A1')], -6)
    expect(next.layers[0].startSec).toBe(0)
    expect(next.audioClips[0].startSec).toBe(2)
  })

  it('moves captions and ignores tiles outside the set', () => {
    const p = project({
      layers: [layer('L1', 0, 10, 'g1'), layer('L2', 0, 4)],
      segments: [caption('C1', 1, 2, 'g1')]
    })
    const next = moveItemsBy(p, [L('L1'), C('C1')], 3)
    expect(next.captions.segments[0]).toMatchObject({ startSec: 4, endSec: 6 })
    expect(next.layers[1].startSec).toBe(0) // untouched
  })
})

describe('splitItemsAt', () => {
  const srcDur = (): number => 0 // explicit out-points everywhere in these fixtures

  it('splits every member the playhead crosses, at the playhead', () => {
    const next = splitItemsAt(pair(), [L('L1'), A('A1')], 5, srcDur, ids())
    expect(next.layers.map((l) => [l.startSec, l.endSec])).toEqual([
      [0, 5],
      [5, 10]
    ])
    const a = next.audioClips
    expect(a).toHaveLength(2)
    expect(a[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: 3 })
    expect(a[1]).toMatchObject({ startSec: 5, inSec: 3, outSec: 6 })
  })

  it('leaves a member the playhead misses whole', () => {
    // Playhead at 1: inside L1 (0..10), before A1 (starts at 2).
    const next = splitItemsAt(pair(), [L('L1'), A('A1')], 1, srcDur, ids())
    expect(next.layers).toHaveLength(2)
    expect(next.audioClips).toHaveLength(1)
    expect(next.audioClips[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: 6 })
  })

  it('gives the two sides separate groups so each can move alone', () => {
    // A distinct id prefix — the fixture's group already owns 'g1'.
    const next = splitItemsAt(pair(), [L('L1'), A('A1')], 5, srcDur, ids('n'))
    const [left, right] = next.layers
    const [aLeft, aRight] = next.audioClips
    expect(left.linkGroupId).toBe('g1') // original group id survives on the left
    expect(aLeft.linkGroupId).toBe('g1')
    expect(right.linkGroupId).toBeDefined()
    expect(right.linkGroupId).not.toBe('g1')
    expect(aRight.linkGroupId).toBe(right.linkGroupId)
  })

  it('puts an uncut member that lives after the cut with the right-hand halves', () => {
    // Cut at 1 splits L1 only; A1 (starting at 2) belongs after the cut.
    const next = splitItemsAt(pair(), [L('L1'), A('A1')], 1, srcDur, ids('n'))
    const [left, right] = next.layers
    expect(left.linkGroupId).toBeUndefined() // alone on its side → pruned
    expect(right.linkGroupId).toBe(next.audioClips[0].linkGroupId)
    expect(right.linkGroupId).toBeDefined()
  })

  it('never cuts a text/image layer or a caption, and no-ops when nothing is cut', () => {
    const p = project({
      layers: [{ ...layer('L1', 0, 10, 'g1'), content: { kind: 'text', text: 'hi' } as Layer['content'] }],
      segments: [caption('C1', 0, 10, 'g1')]
    })
    expect(splitItemsAt(p, [L('L1'), C('C1')], 5, srcDur, ids())).toBe(p)
    expect(canSplitItems(p, [L('L1'), C('C1')], 5, srcDur)).toBe(false)
  })

  it('agrees with `splittableAt` about what a cut would do', () => {
    // The predicate drives the toolbar's disabled state, so it must never claim
    // a cut the split refuses (or hide one it would make).
    const p = pair()
    const refs = [L('L1'), A('A1')]
    for (const t of [-1, 0, 0.0005, 0.5, 2, 5, 7.9995, 8, 9.5, 10, 11]) {
      const cut = splitItemsAt(p, refs, t, srcDur, ids())
      expect(canSplitItems(p, refs, t, srcDur)).toBe(cut !== p)
    }
    expect(splittableAt(p, A('A1'), 5)).toBe(true)
    expect(splittableAt(p, A('A1'), 1)).toBe(false) // before it starts
  })

  it('splits a whole-source audio clip using the resolved source duration', () => {
    const p = project({ audioClips: [{ ...audio('A1', 0, 0), outSec: 0 }] })
    expect(splittableAt(p, A('A1'), 5, () => 8)).toBe(true)
    const next = splitItemsAt(p, [A('A1')], 5, () => 8, ids())
    expect(next.audioClips).toHaveLength(2)
    expect(next.audioClips[1]).toMatchObject({ startSec: 5, inSec: 5, outSec: 0 })
  })

  it('carries freeze holds through a group split (same math as a lone clip)', () => {
    // 10s source with a 2s hold at source 3 → 12s window; cut at 7 = source 5.
    const base = layer('L1', 0, 10, 'g1')
    const c: VideoContent = { ...(base.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
    const p = project({
      layers: [{ ...base, endSec: 12, content: c }],
      audioClips: [audio('A1', 0, 10, 'g1')]
    })
    const next = splitItemsAt(p, [L('L1'), A('A1')], 7, () => 0, ids())
    const [left, right] = next.layers
    expect((left.content as VideoContent).outSec).toBeCloseTo(5, 5)
    expect((left.content as VideoContent).freezes).toEqual([{ atSec: 3, holdSec: 2 }])
    expect(right.endSec).toBe(12)
  })
})

describe('removeItems', () => {
  it('deletes every tile in the group across lanes', () => {
    const next = removeItems(pair(), [L('L1'), A('A1')])
    expect(next.layers).toHaveLength(0)
    expect(next.audioClips).toHaveLength(0)
  })

  it('unlinks the leftovers when a group drops to one member', () => {
    const p = project({
      layers: [layer('L1', 0, 10, 'g1'), layer('L2', 0, 4, 'g1')],
      audioClips: [audio('A1', 0, 4, 'g1')]
    })
    const next = removeItems(p, [L('L2')])
    expect(next.layers[0].linkGroupId).toBe('g1') // still 2 members
    const last = removeItems(next, [A('A1')])
    expect(last.layers[0].linkGroupId).toBeUndefined()
  })

  it('no-ops for refs that no longer exist', () => {
    const p = pair()
    expect(removeItems(p, [L('gone')])).toBe(p)
    expect(removeItems(p, [])).toBe(p)
  })
})

describe('timelineTiles', () => {
  it('marks layouts unlinkable and only video/audio splittable', () => {
    const p = project({
      layers: [
        layer('L1', 0, 10),
        makeLayoutLayer('LO', '2-portrait', 0),
        { ...layer('T1', 0, 3), content: { kind: 'text', text: 'x' } as Layer['content'] }
      ],
      audioClips: [audio('A1', 0, 4)],
      segments: [caption('C1', 0, 2)]
    })
    expect(
      timelineTiles(p).map((t) => [t.ref.id, t.linkable, t.splittable])
    ).toEqual([
      ['L1', true, true],
      ['LO', false, false],
      ['T1', true, false],
      ['C1', true, false],
      ['A1', true, true]
    ])
  })

  it('reports each tile’s start in document order', () => {
    const p = pair()
    expect(startOf(p, L('L1'))).toBe(0)
    expect(startOf(p, A('A1'))).toBe(2)
  })
})
