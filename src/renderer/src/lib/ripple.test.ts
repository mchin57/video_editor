/**
 * Ripple (the promises insert-between makes): every tile on every lane that
 * starts at or after the point moves, a tile that spans it stays uncut, a link
 * group moves whole or not at all, script lines pinned there follow, and
 * closing is the inverse of opening.
 */
import { describe, it, expect } from 'vitest'
import { closableGap, closeGap, makeRoomFor, moveToSeam, openGap, seamNear, tilesFrom, tilesSpan } from './ripple'
import { splitItemsAt, timelineTiles } from './links'
import { makeLayoutLayer } from '@shared/layouts'
import { makeGraphicsLayer, makeImageLayer, makeTextLayer, makeVideoLayer, makeWorkoutLayer } from '@shared/layers'
import { syncCompoundWindows, updateCompAtPath } from '@shared/compositions'
import { createEmptyComposition, createEmptyProject } from '@shared/project'
import type { AudioClip, CaptionSegment, Composition, Layer, Project, TimelineItemRef } from '@shared/project'

const L = (id: string): TimelineItemRef => ({ kind: 'layer', id })
const A = (id: string): TimelineItemRef => ({ kind: 'audio', id })
const C = (id: string): TimelineItemRef => ({ kind: 'caption', id })

const linked = <T extends { linkGroupId?: string }>(item: T, gid?: string): T =>
  gid ? { ...item, linkGroupId: gid } : item

/** A video layer over [startSec, startSec + dur). */
const video = (id: string, startSec: number, dur: number, gid?: string): Layer =>
  linked(makeVideoLayer(id, `media-${id}`, startSec, dur), gid)

function audio(id: string, startSec: number, dur: number, gid?: string): AudioClip {
  return linked<AudioClip>(
    {
      id,
      mediaId: `media-${id}`,
      startSec,
      inSec: 0,
      outSec: dur,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'music'
    },
    gid
  )
}

/** A caption over [startSec, startSec + dur) with one word per second. */
function caption(id: string, startSec: number, dur: number, gid?: string): CaptionSegment {
  const words = Array.from({ length: dur }, (_, i) => ({
    text: `w${i}`,
    startSec: startSec + i,
    endSec: startSec + i + 1
  }))
  return linked<CaptionSegment>(
    { id, startSec, endSec: startSec + dur, text: words.map((w) => w.text).join(' '), words, enabled: true },
    gid
  )
}

function project(parts: {
  layers?: Layer[]
  audioClips?: AudioClip[]
  segments?: CaptionSegment[]
  script?: (number | null)[]
}): Project {
  const p = createEmptyProject('p', 'test')
  return {
    ...p,
    layers: parts.layers ?? [],
    audioClips: parts.audioClips ?? [],
    captions: { ...p.captions, enabled: true, segments: parts.segments ?? [] },
    script: (parts.script ?? []).map((atSec, i) => ({ id: `s${i}`, text: `line ${i}`, atSec }))
  }
}

/** `id → startSec` for every tile, so a whole layout reads as one object. */
const starts = (c: Composition): Record<string, number> =>
  Object.fromEntries(timelineTiles(c).map((t) => [t.ref.id, t.startSec]))

const scriptTimes = (p: Project): (number | null)[] => p.script.map((l) => l.atSec)

/** Three clips end to end, each with linked sound; a caption over the second. */
const cut = (): Project =>
  project({
    layers: [video('V1', 0, 5, 'g1'), video('V2', 5, 2, 'g2'), video('V3', 7, 5, 'g3')],
    audioClips: [audio('A1', 0, 5, 'g1'), audio('A2', 5, 2, 'g2'), audio('A3', 7, 5, 'g3')],
    segments: [caption('C2', 5, 2)],
    script: [1, 5, 6, 8, null]
  })

describe('tilesFrom', () => {
  it('takes every tile kind that starts at or after the point, on every lane', () => {
    const fx = { ...audio('FX', 6, 2), kind: 'fx' as const, fx: {} as AudioClip['fx'] }
    const p = project({
      layers: [
        video('V0', 0, 4),
        video('V', 4, 3),
        makeTextLayer('T', 4, 6),
        makeImageLayer('I', 'pic', 5, 8),
        makeGraphicsLayer('G', 6, 9),
        makeWorkoutLayer('W', 'ride', 7, { inSec: 0, outSec: 4, speed: 1 }, []),
        makeLayoutLayer('LO', '2-portrait', 8)
      ],
      segments: [caption('C0', 1, 2), caption('C', 4, 2)],
      audioClips: [audio('A0', 0, 2), audio('A', 9, 2), fx]
    })
    expect(tilesFrom(p, 4).map((r) => r.id)).toEqual(['V', 'T', 'I', 'G', 'W', 'LO', 'C', 'A', 'FX'])
  })

  it('leaves a tile that spans the point alone: only where it starts decides', () => {
    const p = project({ layers: [video('V', 0, 5), video('V2', 5, 5)], audioClips: [audio('Bed', 0, 30)] })
    expect(tilesFrom(p, 5)).toEqual([L('V2')])
  })

  it('takes a link group whole when its earliest member starts at or after the point', () => {
    // The clip's sound starts a second after its picture: both are "from 5 on".
    const p = project({ layers: [video('V', 5, 4, 'g')], audioClips: [audio('A', 6, 3, 'g')] })
    expect(tilesFrom(p, 5)).toEqual([L('V'), A('A')])
  })

  it('leaves a link group whole when its earliest member starts before the point', () => {
    // A J-cut: the sound leads the picture. The picture starts after the point
    // but stays behind with the sound it is linked to.
    const p = project({ layers: [video('V', 5, 4, 'g'), video('Later', 9, 2)], audioClips: [audio('A', 4, 5, 'g')] })
    expect(tilesFrom(p, 5)).toEqual([L('Later')])
  })

  it('keeps groups on both sides of the point apart', () => {
    expect(tilesFrom(cut(), 5).map((r) => r.id)).toEqual(['V2', 'V3', 'C2', 'A2', 'A3'])
  })

  it('takes everything at point 0', () => {
    const p = cut()
    expect(tilesFrom(p, 0)).toHaveLength(timelineTiles(p).length)
  })

  it('goes by an open-ended audio tile’s start (its end is not needed)', () => {
    const whole = { ...audio('Whole', 6, 0), outSec: 0 } // whole source, length unknown
    const p = project({ audioClips: [{ ...whole, id: 'Before', startSec: 2 }, whole] })
    expect(timelineTiles(p).every((t) => t.endSec === Infinity)).toBe(true)
    expect(tilesFrom(p, 5)).toEqual([A('Whole')])
  })

  it('leaves out skipped tiles, as movers and as group members', () => {
    // With A skipped, V alone decides for the group: it starts at the point.
    const p = project({ layers: [video('V', 5, 4, 'g')], audioClips: [audio('A', 4, 5, 'g')] })
    expect(tilesFrom(p, 5, [A('A')])).toEqual([L('V')])
  })
})

describe('openGap', () => {
  it('moves everything from the point later by the length, and nothing before it', () => {
    const p = cut()
    const next = openGap(p, 5, 3)
    expect(starts(next)).toEqual({ V1: 0, V2: 8, V3: 10, C2: 8, A1: 0, A2: 8, A3: 10 })
    // Durations are untouched, and a moved caption keeps its words in step.
    expect(next.layers.map((l) => l.endSec - l.startSec)).toEqual([5, 2, 5])
    expect(next.captions.segments[0].words.map((w) => w.startSec)).toEqual([8, 9])
  })

  it('leaves a music bed that spans the point where it is, uncut', () => {
    const p = project({ layers: [video('V1', 0, 5), video('V2', 5, 5)], audioClips: [audio('Bed', 0, 30)] })
    const next = openGap(p, 5, 3)
    expect(next.audioClips).toEqual(p.audioClips)
    expect(starts(next)).toEqual({ V1: 0, V2: 8, Bed: 0 })
  })

  it('leaves a group that straddles the point behind, even its member after the point', () => {
    const p = project({ layers: [video('V', 5, 4, 'g'), video('Later', 9, 2)], audioClips: [audio('A', 4, 5, 'g')] })
    expect(starts(openGap(p, 5, 3))).toEqual({ V: 5, Later: 12, A: 4 })
  })

  it('moves the whole timeline for a point at 0', () => {
    expect(starts(openGap(cut(), 0, 2))).toEqual({ V1: 2, V2: 7, V3: 9, C2: 7, A1: 2, A2: 7, A3: 9 })
  })

  it('moves an open-ended audio tile by its start', () => {
    const p = project({ audioClips: [{ ...audio('Whole', 6, 0), outSec: 0 }] })
    expect(openGap(p, 5, 3).audioClips[0]).toMatchObject({ startSec: 9, inSec: 0, outSec: 0 })
  })

  it('moves the script lines pinned at or after the point; unpinned ones stay unpinned', () => {
    expect(scriptTimes(openGap(cut(), 5, 3))).toEqual([1, 8, 9, 11, null])
  })

  it('is a no-op for no length, and when nothing starts at or after the point', () => {
    const p = cut()
    expect(openGap(p, 5, 0)).toBe(p)
    expect(openGap(p, 5, -1)).toBe(p)
    expect(openGap(p, 100, 3)).toBe(p)
  })

  it('does not move skipped tiles', () => {
    expect(starts(openGap(cut(), 5, 3, [L('V2'), A('A2')]))).toMatchObject({ V2: 5, A2: 5, V3: 10, C2: 8 })
  })
})

describe('closeGap', () => {
  it('is the inverse of openGap', () => {
    const p = cut()
    const back = closeGap(openGap(p, 5, 3), 5, 3)
    expect(starts(back)).toEqual(starts(p))
    expect(scriptTimes(back)).toEqual(scriptTimes(p))
    expect(back.captions.segments).toEqual(p.captions.segments)
  })

  it('moves everything from the point earlier, leaving a spanning tile where it is', () => {
    const p = project({ layers: [video('V1', 0, 5), video('V3', 8, 4)], audioClips: [audio('Bed', 0, 30)] })
    expect(starts(closeGap(p, 5, 3))).toEqual({ V1: 0, V3: 5, Bed: 0 })
  })

  it('never moves past 0: the set stops when its earliest tile gets there, offsets kept', () => {
    const p = project({ layers: [video('V', 2, 4)], audioClips: [audio('A', 3, 4)] })
    expect(closableGap(p, 0, 5)).toBe(2)
    expect(starts(closeGap(p, 0, 5))).toEqual({ V: 0, A: 1 })
  })

  it('pins a script line inside the closed stretch to its start', () => {
    const p = project({ layers: [video('V3', 8, 4)], script: [2, 6, 8, 9] })
    expect(scriptTimes(closeGap(p, 5, 3))).toEqual([2, 5, 5, 6])
  })

  it('leaves a straddling group where it is', () => {
    const p = project({ layers: [video('V', 8, 4, 'g'), video('Later', 12, 2)], audioClips: [audio('A', 4, 8, 'g')] })
    expect(starts(closeGap(p, 5, 3))).toEqual({ V: 8, Later: 9, A: 4 })
  })

  it('is a no-op for no length, and when there is nothing to move', () => {
    const p = cut()
    expect(closeGap(p, 5, 0)).toBe(p)
    expect(closeGap(project({ layers: [video('V', 0, 5)] }), 5, 3).layers[0].startSec).toBe(0)
  })
})

describe('tilesSpan', () => {
  it('runs from the earliest start to the latest known end', () => {
    const p = project({
      layers: [video('V', 5, 4)],
      audioClips: [audio('A', 4, 2), { ...audio('W', 6, 0), outSec: 0 }]
    })
    expect(tilesSpan(timelineTiles(p))).toEqual({ startSec: 4, endSec: 9 })
    expect(tilesSpan(timelineTiles(p, () => 20))).toEqual({ startSec: 4, endSec: 26 })
    expect(tilesSpan([])).toBeNull()
  })
})

describe('makeRoomFor (insert something new)', () => {
  /** `p` with a 3 s picture added at `atSec`. */
  const withImage = (p: Project, atSec: number): Project => ({
    ...p,
    layers: [...p.layers, makeImageLayer('New', 'pic', atSec, atSec + 3, {})]
  })

  it('opens a gap as long as the new item, which stays at the point', () => {
    const p = cut()
    const next = makeRoomFor(p, withImage(p, 5), 5)
    expect(starts(next)).toEqual({ V1: 0, V2: 8, V3: 10, New: 5, C2: 8, A1: 0, A2: 8, A3: 10 })
    expect(scriptTimes(next)).toEqual([1, 8, 9, 11, null])
  })

  it('opens a gap as long as a new clip’s link group', () => {
    const p = cut()
    // A clip whose sound runs a second longer than its picture.
    const added: Project = {
      ...p,
      layers: [...p.layers, video('New', 5, 4, 'gn')],
      audioClips: [...p.audioClips, audio('NewA', 5, 5, 'gn')]
    }
    const next = makeRoomFor(p, added, 5)
    expect(starts(next)).toMatchObject({ New: 5, NewA: 5, V2: 10, A2: 10, C2: 10, V3: 12 })
  })

  it('measures a new whole-source sound with the source length', () => {
    const p = project({ layers: [video('V', 5, 5)] })
    const added: Project = { ...p, audioClips: [{ ...audio('New', 5, 0), outSec: 0 }] }
    expect(starts(makeRoomFor(p, added, 5, () => 7))).toEqual({ V: 12, New: 5 })
    // Length unknown: there is no gap to open.
    expect(starts(makeRoomFor(p, added, 5))).toEqual({ V: 5, New: 5 })
  })

  it('moves the whole timeline for an insert at 0, and changes nothing when nothing was added', () => {
    const p = cut()
    expect(starts(makeRoomFor(p, withImage(p, 0), 0))).toMatchObject({ New: 0, V1: 3, A1: 3, V3: 10 })
    expect(makeRoomFor(p, p, 5)).toBe(p)
  })
})

describe('moveToSeam (lift tiles out and insert them elsewhere)', () => {
  const clip2 = [L('V2'), A('A2')]

  it('moves a clip later: the hole closes and the clip lands at the seam', () => {
    // V1 V2 V3 → V1 V3 V2 (the seam at 12 is the end of V3).
    const next = moveToSeam(cut(), clip2, 12)
    expect(starts(next)).toMatchObject({ V1: 0, A1: 0, V3: 5, A3: 5, V2: 10, A2: 10 })
  })

  it('moves a clip earlier: room opens at the seam and the hole closes', () => {
    // V1 V2 V3 → V2 V1 V3.
    const next = moveToSeam(cut(), clip2, 0)
    expect(starts(next)).toMatchObject({ V2: 0, A2: 0, V1: 2, A1: 2, V3: 7, A3: 7 })
  })

  it('moves the first clip between the other two, keeping the timeline flush at 0', () => {
    const next = moveToSeam(cut(), [L('V1'), A('A1')], 7)
    expect(starts(next)).toMatchObject({ V2: 0, A2: 0, V1: 2, A1: 2, V3: 7, A3: 7 })
  })

  it('keeps the offsets inside the moved set', () => {
    const p = project({
      layers: [video('V1', 0, 5), video('V2', 5, 2, 'g'), video('V3', 7, 5)],
      audioClips: [audio('A2', 5.5, 1, 'g')]
    })
    const next = moveToSeam(p, [L('V2'), A('A2')], 0)
    expect(starts(next)).toEqual({ V1: 2, V2: 0, V3: 7, A2: 0.5 })
  })

  it('leaves a tile that spans the hole and the seam where it is', () => {
    const p = { ...cut(), audioClips: [...cut().audioClips, audio('Bed', 0, 30)] }
    expect(starts(moveToSeam(p, clip2, 12)).Bed).toBe(0)
  })

  it('does not carry an UNLINKED tile that sat inside the set’s span: it ripples like any other', () => {
    // C2 (5–7) is a caption over V2 but not linked to it. Closing the hole moves
    // it earlier with everything from 5 on (to 3); it is before the seam, so it
    // stays there instead of following V2 to 10. Link it to keep them together.
    expect(starts(moveToSeam(cut(), clip2, 12)).C2).toBe(3)
    const together = { ...cut(), captions: { ...cut().captions, segments: [caption('C2', 5, 2, 'g2')] } }
    expect(starts(moveToSeam(together, [...clip2, C('C2')], 12)).C2).toBe(10)
  })

  it('carries the script lines pinned inside the set; the rest ripple', () => {
    // Lines at 5 and 6 sit on V2 and ride with it (+5); the line at 8 sits on
    // V3 and moves left with it (-2); the line at 1 is before everything.
    expect(scriptTimes(moveToSeam(cut(), clip2, 12))).toEqual([1, 10, 11, 6, null])
  })

  it('changes nothing for a seam at the set’s own edges or inside its span', () => {
    const p = cut()
    expect(moveToSeam(p, clip2, 5)).toBe(p)
    expect(moveToSeam(p, clip2, 7)).toBe(p)
    expect(moveToSeam(p, clip2, 6)).toBe(p)
    expect(moveToSeam(p, [L('gone')], 0)).toBe(p)
  })

  it('measures an open-ended audio tile with the source length', () => {
    const whole = { ...audio('W', 5, 0), outSec: 0 }
    const p = project({ layers: [video('V1', 0, 5), video('V3', 7, 5)], audioClips: [whole] })
    // 2 s of source: the tile covers 5–7, like V2 in `cut()`.
    expect(starts(moveToSeam(p, [A('W')], 12, () => 2))).toEqual({ V1: 0, V3: 5, W: 10 })
    // Length unknown: nothing to lift.
    expect(moveToSeam(p, [A('W')], 12)).toBe(p)
  })

  it('still splits a moved caption between its words', () => {
    const p = project({ layers: [video('V1', 0, 5)], segments: [caption('C', 5, 4)] })
    const next = moveToSeam(p, [C('C')], 0)
    const split = splitItemsAt(
      next,
      [C('C')],
      2,
      () => 0,
      () => 'right'
    )
    expect(split.captions.segments.map((s) => s.text)).toEqual(['w0 w1', 'w2 w3'])
  })
})

describe('inside a nested composition', () => {
  it('ripples the composition being edited, grows its parent block and leaves the root alone', () => {
    const inner: Composition = {
      ...createEmptyComposition(),
      layers: [video('In1', 0, 4), video('In2', 4, 4)],
      audioClips: [audio('InA', 4, 4)]
    }
    const block: Layer = { ...video('Block', 2, 8), content: { kind: 'compound', comp: inner } }
    const root = project({ layers: [block, video('After', 10, 3)], script: [5] })

    const next = syncCompoundWindows(updateCompAtPath(root, [{ layerId: 'Block' }], (c) => openGap(c, 4, 3))) as Project
    const comp = (next.layers[0].content as Extract<Layer['content'], { kind: 'compound' }>).comp
    expect(starts(comp)).toEqual({ In1: 0, In2: 7, InA: 7 })
    // The block follows its composition's new length; nothing else on the root
    // moves, and the root's script lines are not on this timeline.
    expect(next.layers[0]).toMatchObject({ startSec: 2, endSec: 13 })
    expect(next.layers[1].startSec).toBe(10)
    expect(scriptTimes(next)).toEqual([5])
  })
})

describe('seamNear', () => {
  const tiles = timelineTiles(
    project({
      layers: [video('V1', 0, 5), video('V2', 5, 2), video('V3', 9, 3), makeTextLayer('T', 3, 6)],
      audioClips: [audio('A1', 1, 3), audio('A2', 4, 4)]
    })
  )

  it('finds where two tiles meet in the lane under the pointer', () => {
    expect(seamNear(tiles, 'clips', 5.1, 0.2)).toBe(5)
    expect(seamNear(tiles, 'audio', 3.9, 0.2)).toBe(4)
  })

  it('ignores a tile edge with a gap beside it, and seams in other lanes', () => {
    expect(seamNear(tiles, 'clips', 7, 0.2)).toBeNull() // V2 ends, nothing starts
    expect(seamNear(tiles, 'clips', 9, 0.2)).toBeNull() // V3 starts after a gap
    expect(seamNear(tiles, 'clips', 12, 0.2)).toBeNull() // the end of the last tile
    expect(seamNear(tiles, 'clips', 4, 0.2)).toBeNull() // the audio lane's seam
    expect(seamNear(tiles, 'text', 5, 0.2)).toBeNull()
  })

  it('counts the very start of the timeline in any lane, and with no lane', () => {
    expect(seamNear(tiles, 'clips', 0.1, 0.2)).toBe(0)
    expect(seamNear(tiles, 'text', 0.1, 0.2)).toBe(0)
    expect(seamNear(tiles, null, 0.1, 0.2)).toBe(0)
    expect(seamNear([], null, 0, 0.2)).toBe(0)
    expect(seamNear(tiles, null, 5, 0.2)).toBeNull()
  })

  it('is null away from any seam, and picks the nearest of two', () => {
    expect(seamNear(tiles, 'clips', 5.3, 0.2)).toBeNull()
    const close = timelineTiles(project({ layers: [video('a', 0, 1), video('b', 1, 0.3), video('c', 1.3, 2)] }))
    expect(seamNear(close, 'clips', 1.2, 0.5)).toBe(1.3)
    expect(seamNear(close, 'clips', 1.1, 0.5)).toBe(1)
  })

  it('treats tiles less than a frame apart as meeting, at the later tile’s start', () => {
    const near = timelineTiles(project({ layers: [video('a', 0, 5), video('b', 5.01, 2)] }))
    expect(seamNear(near, 'clips', 5, 0.2)).toBe(5.01)
  })
})
