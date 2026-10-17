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
  snapToPreviousDelta,
  splitGroupOnSilence,
  splitItemsAt,
  splittableAt,
  toggleMuteItems,
  timelineTiles,
  trimItemsBy,
  unlinkItems
} from './links'
import { makeLayoutLayer } from '@shared/layouts'
import { makeVideoLayer } from '@shared/layers'
import { createEmptyProject } from '@shared/project'
import type {
  AudioClip,
  CaptionSegment,
  Layer,
  Composition,
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

/** A text layer over [startSec, startSec + dur]. */
function textLayer(id: string, startSec: number, dur: number, gid?: string): Layer {
  const l = layer(id, startSec, dur, gid)
  return { ...l, content: { kind: 'text', text: id } as Layer['content'] }
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

const startOf = (p: Composition, ref: TimelineItemRef): number =>
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

describe('trimItemsBy', () => {
  it('takes the same time off every member’s edge, whatever their lengths', () => {
    // L1 0..10, A1 2..8 — trimming 3s off the right takes 3s off each.
    const next = trimItemsBy(pair(), [L('L1'), A('A1')], 'end', -3)
    expect(next.layers[0].endSec).toBe(7)
    expect((next.layers[0].content as VideoContent).outSec).toBeCloseTo(7, 5)
    expect(next.audioClips[0].outSec).toBeCloseTo(3, 5) // 6s − 3s of source
    expect(next.audioClips[0].startSec).toBe(2) // the left edge never moved
  })

  it('trims the left edge of every member, moving each start with its in-point', () => {
    const next = trimItemsBy(pair(), [L('L1'), A('A1')], 'start', 2)
    expect(next.layers[0].startSec).toBe(2)
    expect((next.layers[0].content as VideoContent).inSec).toBeCloseTo(2, 5)
    expect(next.audioClips[0].startSec).toBe(4)
    expect(next.audioClips[0].inSec).toBeCloseTo(2, 5)
  })

  it('clamps the group to what its most constrained member can give', () => {
    // A1 only has 6s of source, so a 7s right-trim stops at what BOTH can do:
    // 6s − 0.1s minimum = 5.9s.
    const next = trimItemsBy(pair(), [L('L1'), A('A1')], 'end', -7)
    expect(next.audioClips[0].outSec).toBeCloseTo(0.1, 5)
    expect(next.layers[0].endSec).toBeCloseTo(10 - 5.9, 5) // same delta, still in step
  })

  it('does not extend past a member’s source when the duration is known', () => {
    // A1's source is 6s and it's fully used, so nothing can grow to the right.
    const p = pair()
    expect(trimItemsBy(p, [L('L1'), A('A1')], 'end', 5, () => 6)).toBe(p)
  })

  it('respects a 2× clip’s speed profile: the same TIMELINE delta, more source', () => {
    // 10s of source at 2× plays for 5s; trimming 1s of timeline off the right
    // gives back 2s of source, while the audio gives back 1s (it plays at 1×).
    const base = layer('L1', 0, 10, 'g1')
    const c: VideoContent = { ...(base.content as VideoContent), speed: 2 }
    const p = project({
      layers: [{ ...base, endSec: 5, content: c }],
      audioClips: [audio('A1', 0, 6, 'g1')]
    })
    const next = trimItemsBy(p, [L('L1'), A('A1')], 'end', -1)
    expect(next.layers[0].endSec).toBeCloseTo(4, 5)
    expect((next.layers[0].content as VideoContent).outSec).toBeCloseTo(8, 5)
    expect(next.audioClips[0].outSec).toBeCloseTo(5, 5)
  })

  it('keeps a minimum window on a text tile and no-ops for a zero delta', () => {
    const p = project({ layers: [textLayer('T1', 0, 10, 'g1'), textLayer('T2', 0, 10, 'g1')] })
    const next = trimItemsBy(p, [L('T1'), L('T2')], 'end', -20)
    expect(next.layers.map((l) => l.endSec)).toEqual([0.2, 0.2])
    expect(trimItemsBy(p, [L('T1'), L('T2')], 'end', 0)).toBe(p)
    expect(trimItemsBy(p, [], 'end', -1)).toBe(p)
  })

  it('trims a caption member with the group', () => {
    const p = project({
      layers: [textLayer('T1', 0, 10, 'g1')],
      segments: [caption('C1', 0, 10, 'g1')]
    })
    const next = trimItemsBy(p, [L('T1'), C('C1')], 'end', -4)
    expect(next.layers[0].endSec).toBe(6)
    expect(next.captions.segments[0].endSec).toBe(6)
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

  it('keeps a linked audio clip volume level on both halves', () => {
    const p = pair()
    const inLevel = { ...p, audioClips: p.audioClips.map((a) => ({ ...a, volumeLevelId: 'lvl' })) }
    const next = splitItemsAt(inLevel, [L('L1'), A('A1')], 5, srcDur, ids('n'))
    expect(next.audioClips.map((a) => a.volumeLevelId)).toEqual(['lvl', 'lvl'])
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

  it('cuts a linked text layer and caption at the playhead too', () => {
    const p = project({
      layers: [textLayer('T1', 0, 10, 'g1')],
      segments: [caption('C1', 0, 10, 'g1')]
    })
    expect(canSplitItems(p, [L('T1'), C('C1')], 5, srcDur)).toBe(true)
    const next = splitItemsAt(p, [L('T1'), C('C1')], 5, srcDur, ids('n'))
    expect(next.layers.map((l) => [l.startSec, l.endSec])).toEqual([
      [0, 5],
      [5, 10]
    ])
    expect(next.captions.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 5],
      [5, 10]
    ])
    // Each side is one group spanning both lanes.
    expect(next.layers[0].linkGroupId).toBe(next.captions.segments[0].linkGroupId)
    expect(next.layers[1].linkGroupId).toBe(next.captions.segments[1].linkGroupId)
    expect(next.layers[0].linkGroupId).not.toBe(next.layers[1].linkGroupId)
  })

  it('never cuts a layout, and no-ops when nothing is cut', () => {
    const p = project({ layers: [makeLayoutLayer('LO', '2-portrait', 0)] })
    expect(canSplitItems(p, [L('LO')], 1, srcDur)).toBe(false)
    expect(splitItemsAt(p, [L('LO')], 1, srcDur, ids())).toBe(p)
    // Nor outside a tile's span.
    const q = pair()
    expect(splitItemsAt(q, [L('L1'), A('A1')], 20, srcDur, ids())).toBe(q)
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

describe('splitGroupOnSilence', () => {
  const srcDur = (): number => 0 // explicit out-points everywhere in these fixtures
  const gid = (p: Composition, ref: TimelineItemRef): string | undefined =>
    timelineTiles(p).find((t) => t.ref.kind === ref.kind && t.ref.id === ref.id)?.linkGroupId
  const synced = (): Project =>
    project({ layers: [layer('L1', 0, 10, 'g1')], audioClips: [audio('A1', 0, 10, 'g1')] })

  it('cuts the whole group at every speech boundary and pairs the speech slices', () => {
    const next = splitGroupOnSilence(synced(), 'A1', [{ start: 1, end: 3 }, { start: 5, end: 8 }], srcDur, ids())
    // The video is cut at 1, 3, 5 and 8 and keeps every slice (no black gaps)…
    expect(next.layers.map((l) => [l.startSec, l.endSec])).toEqual([[0, 1], [1, 3], [3, 5], [5, 8], [8, 10]])
    // …the audio keeps only its speech.
    expect(next.audioClips.map((a) => [a.startSec, a.inSec, a.outSec])).toEqual([[1, 1, 3], [5, 5, 8]])
    // Speech slice N of the audio ↔ the video's slice N, each pair its own group.
    const [s1, s2] = next.audioClips
    const v = next.layers
    expect(gid(next, A(s1.id))).toBeDefined()
    expect(gid(next, L(v[1].id))).toBe(gid(next, A(s1.id)))
    expect(gid(next, L(v[3].id))).toBe(gid(next, A(s2.id)))
    expect(gid(next, A(s1.id))).not.toBe(gid(next, A(s2.id)))
    // The video's silent slices have no partner left: unlinked.
    for (const i of [0, 2, 4]) expect(v[i].linkGroupId).toBeUndefined()
  })

  it('maps source boundaries through the audio clip placement (offset start + trimmed in)', () => {
    const p = project({ layers: [layer('L1', 0, 10, 'g1')], audioClips: [{ ...audio('A1', 2, 6, 'g1'), inSec: 4, outSec: 10 }] })
    // Source 5–7 plays at timeline 3–5.
    const next = splitGroupOnSilence(p, 'A1', [{ start: 5, end: 7 }], srcDur, ids())
    expect(next.layers.map((l) => [l.startSec, l.endSec])).toEqual([[0, 3], [3, 5], [5, 10]])
    expect(next.audioClips).toHaveLength(1)
    expect(next.audioClips[0]).toMatchObject({ startSec: 3, inSec: 5, outSec: 7 })
    expect(gid(next, L(next.layers[1].id))).toBe(gid(next, A(next.audioClips[0].id)))
  })

  it('leaves a member no boundary crosses whole', () => {
    const p = project({
      layers: [layer('L1', 0, 10, 'g1')],
      audioClips: [audio('A1', 0, 10, 'g1')],
      segments: [caption('C1', 6, 1, 'g1')]
    })
    const next = splitGroupOnSilence(p, 'A1', [{ start: 1, end: 3 }], srcDur, ids())
    expect(next.captions.segments.map((s) => [s.startSec, s.endSec])).toEqual([[6, 7]])
  })

  it('is a no-op when the speech covers the whole clip', () => {
    const p = synced()
    expect(splitGroupOnSilence(p, 'A1', [{ start: 0, end: 10 }], srcDur, ids())).toBe(p)
    expect(splitGroupOnSilence(p, 'A1', [], srcDur, ids())).toBe(p)
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
  it('marks the layout — and only the layout — neither linkable nor splittable', () => {
    const p = project({
      layers: [layer('L1', 0, 10), makeLayoutLayer('LO', '2-portrait', 0), textLayer('T1', 0, 3)],
      audioClips: [audio('A1', 0, 4)],
      segments: [caption('C1', 0, 2)]
    })
    expect(timelineTiles(p).map((t) => [t.ref.id, t.linkable, t.splittable])).toEqual([
      ['L1', true, true],
      ['LO', false, false],
      ['T1', true, true],
      ['C1', true, true],
      ['A1', true, true]
    ])
  })

  it('reports each tile’s start in document order', () => {
    const p = pair()
    expect(startOf(p, L('L1'))).toBe(0)
    expect(startOf(p, A('A1'))).toBe(2)
  })
})

describe('snapToPreviousDelta', () => {
  it('closes the gap to the previous clip in the same lane', () => {
    const p = project({ layers: [layer('L1', 0, 4), layer('L2', 10, 3)] })
    expect(snapToPreviousDelta(p, [L('L2')])).toBeCloseTo(-6)
    const after = moveItemsBy(p, [L('L2')], snapToPreviousDelta(p, [L('L2')])!)
    expect(startOf(after, L('L2'))).toBeCloseTo(4)
  })

  it('picks the NEAREST preceding tile, not the first', () => {
    const p = project({ layers: [layer('L1', 0, 2), layer('L2', 5, 2), layer('L3', 20, 2)] })
    expect(snapToPreviousDelta(p, [L('L3')])).toBeCloseTo(-13) // to L2's end at 7
  })

  it('snaps to 0 when nothing precedes it in the lane', () => {
    const p = project({ layers: [layer('L1', 8, 2)] })
    expect(snapToPreviousDelta(p, [L('L1')])).toBeCloseTo(-8)
  })

  it('ignores tiles in other lanes', () => {
    // A text tile ending at 9 must not pull a CLIPS tile — different bands.
    const p = project({ layers: [layer('L1', 12, 2), textLayer('T1', 3, 6)] })
    expect(snapToPreviousDelta(p, [L('L1')])).toBeCloseTo(-12)
    expect(snapToPreviousDelta(p, [L('T1')])).toBeCloseTo(-3)
  })

  it('separates the audio and fx bands', () => {
    const fx = { ...audio('F1', 0, 5), fx: {} as AudioClip['fx'] }
    const p = project({ audioClips: [fx, audio('A1', 9, 2)] })
    // A1 is in the audio lane; the fx tile ending at 5 is a different band.
    expect(snapToPreviousDelta(p, [A('A1')])).toBeCloseTo(-9)
  })

  it('pushes RIGHT to close an overlap with the previous clip', () => {
    const p = project({ layers: [layer('L1', 0, 10), layer('L2', 4, 3)] })
    expect(snapToPreviousDelta(p, [L('L2')])).toBeCloseTo(6) // out to L1's end at 10
  })

  it('returns null when already flush', () => {
    const p = project({ layers: [layer('L1', 0, 4), layer('L2', 4, 3)] })
    expect(snapToPreviousDelta(p, [L('L2')])).toBeNull()
  })

  it('returns null for refs that do not resolve', () => {
    expect(snapToPreviousDelta(project({ layers: [layer('L1', 0, 4)] }), [L('nope')])).toBeNull()
  })

  it('moves a link group as one, off its EARLIEST member', () => {
    // Group = L1 [10,20] + its audio A1 [12,18]; a clip ends at 4.
    const p = project({
      layers: [layer('P0', 0, 4), layer('L1', 10, 10, 'g1')],
      audioClips: [audio('A1', 12, 6, 'g1')]
    })
    const refs = [L('L1'), A('A1')]
    const d = snapToPreviousDelta(p, refs)!
    expect(d).toBeCloseTo(-6) // anchor L1 10 → 4
    const after = moveItemsBy(p, refs, d)
    expect(startOf(after, L('L1'))).toBeCloseTo(4)
    expect(startOf(after, A('A1'))).toBeCloseTo(6) // offset preserved
  })

  it('never snaps a tile onto a member of its own selection', () => {
    const p = project({ layers: [layer('L1', 0, 4), layer('L2', 10, 3)] })
    // Both selected: L1 is the anchor and L2 is excluded as a candidate, so the
    // set slides to the start rather than L2 collapsing onto L1.
    expect(snapToPreviousDelta(p, [L('L1'), L('L2')])).toBeNull()
  })

  it('skips an open-ended audio tile as a snap target', () => {
    // outSec 0 + unknown source duration = an unknown end; can't snap to it.
    const open = { ...audio('A0', 0, 0), outSec: 0 }
    const p = project({ audioClips: [open, audio('A1', 9, 2)] })
    expect(snapToPreviousDelta(p, [A('A1')])).toBeCloseTo(-9)
    // With the duration known, it becomes a real target.
    expect(snapToPreviousDelta(p, [A('A1')], () => 5)).toBeCloseTo(-4)
  })
})

describe('toggleMuteItems (the M key)', () => {
  const muted = (p: Composition): boolean[] => [
    ...p.layers.map((l) => l.content.kind === 'video' && l.content.mute),
    ...p.audioClips.map((a) => !!a.mute)
  ]

  it('toggles a video layer and an audio clip together, and back', () => {
    const p = project({ layers: [layer('L1', 0, 10)], audioClips: [audio('A1', 2, 6)] })
    const once = toggleMuteItems(p, [L('L1'), A('A1')])
    expect(muted(once)).toEqual([true, true])
    expect(muted(toggleMuteItems(once, [L('L1'), A('A1')]))).toEqual([false, false])
  })

  it('a mixed selection mutes all first, then unmutes all', () => {
    const p = project({ layers: [layer('L1', 0, 10)], audioClips: [{ ...audio('A1', 2, 6), mute: true }] })
    const once = toggleMuteItems(p, [L('L1'), A('A1')])
    expect(muted(once)).toEqual([true, true])
    expect(muted(toggleMuteItems(once, [L('L1'), A('A1')]))).toEqual([false, false])
  })

  it('leaves unselected tiles alone and ignores tiles without sound', () => {
    const p = project({ layers: [layer('L1', 0, 10), textLayer('T1', 0, 3)], audioClips: [audio('A1', 2, 6)] })
    expect(muted(toggleMuteItems(p, [A('A1')]))).toEqual([false, false, true])
    expect(toggleMuteItems(p, [L('T1'), C('nope')])).toBe(p)
  })
})
