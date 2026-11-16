/**
 * Transitions on the timeline (#64): applying slides the incoming clip, its
 * group and everything after it left by the length (the reel gets shorter),
 * puts it above the outgoing clip and crossfades the linked sound; a length
 * change slides again; removing leaves the overlap.
 */
import { describe, it, expect } from 'vitest'
import type { AudioClip, Composition, Layer, LayerTransition, TimelineItemRef } from '@shared/project'
import { createEmptyComposition, createEmptyProject } from '@shared/project'
import { makeImageLayer, makeTextLayer, makeVideoLayer } from '@shared/layers'
import { pairOf, transitionPairs } from '@shared/transitions'
import {
  applyTransition,
  maxSideSec,
  placeAbove,
  removeTransition,
  setFade,
  setTransitionKind,
  setTransitionLength,
  transitionCandidate
} from './transitions'
import { shiftFrom } from './ripple'

const L = (id: string): TimelineItemRef => ({ kind: 'layer', id })
const tr = (kind: LayerTransition['kind'], sec: number): LayerTransition => ({ kind, sec })
const video = (id: string, start: number, dur: number, gid?: string): Layer => ({
  ...makeVideoLayer(id, `m-${id}`, start, dur, { mute: !!gid }),
  ...(gid ? { linkGroupId: gid } : {})
})
const audio = (id: string, start: number, dur: number, gid?: string): AudioClip => ({
  id,
  mediaId: `m-${id}`,
  startSec: start,
  inSec: 0,
  outSec: dur,
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  duck: false,
  kind: 'extracted',
  ...(gid ? { linkGroupId: gid } : {})
})
const comp = (layers: Layer[], audioClips: AudioClip[] = []): Composition => ({
  ...createEmptyComposition(),
  layers,
  audioClips
})
const get = (c: Composition, id: string): Layer => c.layers.find((l) => l.id === id)!
const getA = (c: Composition, id: string): AudioClip => c.audioClips.find((a) => a.id === id)!

/** A (0–4) | B (4–8) | C (8–12), each with linked audio, a title over C. */
function reel(): Composition {
  return comp(
    [video('A', 0, 4, 'ga'), video('B', 4, 4, 'gb'), video('C', 8, 4, 'gc'), makeTextLayer('T', 8.5, 10)],
    [audio('a', 0, 4, 'ga'), audio('b', 4, 4, 'gb'), audio('c', 8, 4, 'gc')]
  )
}
const AB: TimelineItemRef[] = [L('A'), { kind: 'audio', id: 'a' }, L('B'), { kind: 'audio', id: 'b' }]

describe('transitionCandidate — two neighbouring clips', () => {
  it('takes two clips that meet (their audio in the selection or not) at the default length', () => {
    expect(transitionCandidate(reel(), AB)).toEqual({ ok: true, outId: 'A', inId: 'B', sec: 0.5, slide: 0.5 })
    expect(transitionCandidate(reel(), [L('B'), L('A')])).toMatchObject({ ok: true, outId: 'A', inId: 'B' })
  })

  it('refuses one clip, three, a gap, clips linked to each other, one inside the other', () => {
    expect(transitionCandidate(reel(), [L('A')]).ok).toBe(false)
    expect(transitionCandidate(reel(), [L('A'), L('B'), L('C')]).ok).toBe(false)
    expect(transitionCandidate(reel(), [L('A'), L('C')]).ok).toBe(false)
    const linked = comp([video('A', 0, 4, 'g'), video('B', 4, 4, 'g')])
    expect(transitionCandidate(linked, [L('A'), L('B')])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/linked/)
    })
    const inside = comp([video('A', 0, 8), video('B', 2, 2)])
    expect(transitionCandidate(inside, [L('A'), L('B')]).ok).toBe(false)
    // Text does not take transitions.
    const text = comp([video('A', 0, 4), makeTextLayer('T', 4, 8)])
    expect(transitionCandidate(text, [L('A'), L('T')]).ok).toBe(false)
  })

  it('is never longer than half the shorter clip', () => {
    const short = comp([video('A', 0, 4), video('B', 4, 0.6)])
    expect(transitionCandidate(short, [L('A'), L('B')])).toMatchObject({ ok: true, sec: 0.3, slide: 0.3 })
    const tooShort = comp([video('A', 0, 4), video('B', 4, 0.15)])
    expect(transitionCandidate(tooShort, [L('A'), L('B')]).ok).toBe(false)
  })

  it('clips that already overlap (a transition removed earlier) take the overlap, no slide', () => {
    const over = comp([video('A', 0, 4), video('B', 3.2, 4)])
    expect(transitionCandidate(over, [L('A'), L('B')])).toMatchObject({ ok: true, sec: 0.8, slide: 0 })
    const tooMuch = comp([video('A', 0, 4), video('B', 1, 6)])
    expect(transitionCandidate(tooMuch, [L('A'), L('B')]).ok).toBe(false)
  })

  it('works for image tiles', () => {
    const imgs = comp([makeImageLayer('A', 'm', 0, 3), makeImageLayer('B', 'm', 3, 6)])
    expect(transitionCandidate(imgs, [L('A'), L('B')])).toMatchObject({ ok: true, sec: 0.5 })
  })
})

describe('applyTransition', () => {
  it('slides the incoming clip, its group and everything after it left by the length', () => {
    const c = applyTransition(reel(), AB, 'dissolve')
    expect(get(c, 'A')).toMatchObject({ startSec: 0, endSec: 4 })
    expect(get(c, 'B')).toMatchObject({ startSec: 3.5, endSec: 7.5 })
    expect(get(c, 'C')).toMatchObject({ startSec: 7.5, endSec: 11.5 })
    expect(get(c, 'T')).toMatchObject({ startSec: 8, endSec: 9.5 })
    expect(getA(c, 'a').startSec).toBe(0)
    expect(getA(c, 'b').startSec).toBe(3.5)
    expect(getA(c, 'c').startSec).toBe(7.5)
  })

  it('stores both sides, which pair', () => {
    const c = applyTransition(reel(), AB, 'dipBlack')
    expect(get(c, 'A').transitionOut).toEqual(tr('dipBlack', 0.5))
    expect(get(c, 'B').transitionIn).toEqual(tr('dipBlack', 0.5))
    expect(transitionPairs(c.layers)).toEqual([{ outId: 'A', inId: 'B', kind: 'dipBlack', sec: 0.5 }])
  })

  it('crossfades the two clips’ linked sound over the same window', () => {
    const c = applyTransition(reel(), AB, 'dissolve')
    expect(getA(c, 'a').fadeOutSec).toBe(0.5)
    expect(getA(c, 'b').fadeInSec).toBe(0.5)
    expect(getA(c, 'a').fadeInSec).toBe(0)
    expect(getA(c, 'c')).toMatchObject({ fadeInSec: 0, fadeOutSec: 0 })
  })

  it('puts the incoming clip above the outgoing one when it was below', () => {
    const base = reel()
    const swapped = { ...base, layers: [base.layers[1], base.layers[0], base.layers[2], base.layers[3]] }
    const c = applyTransition(swapped, AB, 'dissolve')
    expect(c.layers.map((l) => l.id)).toEqual(['A', 'B', 'C', 'T'])
    // Already above: the stack is left alone.
    expect(applyTransition(reel(), AB, 'dissolve').layers.map((l) => l.id)).toEqual(['A', 'B', 'C', 'T'])
  })

  it('moves the script lines pinned after the point on the root timeline', () => {
    const project = {
      ...createEmptyProject('p', 'P'),
      ...reel(),
      script: [
        { id: 's1', text: 'one', atSec: 2 },
        { id: 's2', text: 'two', atSec: 9 }
      ]
    }
    const c = applyTransition(project, AB, 'dissolve')
    expect(c.script.map((l) => l.atSec)).toEqual([2, 8.5])
  })

  it('changes nothing for a selection that does not qualify, or a fade', () => {
    const c = reel()
    expect(applyTransition(c, [L('A'), L('C')], 'dissolve')).toBe(c)
    expect(applyTransition(c, AB, 'fade')).toBe(c)
  })
})

describe('length, kind, removal and fades', () => {
  const applied = (): Composition => applyTransition(reel(), AB, 'dissolve')

  it('a longer pair slides the incoming side further in; shorter slides it back out', () => {
    const c = setTransitionLength(applied(), 'B', 'in', 1)
    expect(get(c, 'B')).toMatchObject({ startSec: 3, transitionIn: tr('dissolve', 1) })
    expect(get(c, 'A').transitionOut).toEqual(tr('dissolve', 1))
    expect(get(c, 'C').startSec).toBe(7)
    expect(getA(c, 'a').fadeOutSec).toBe(1)
    expect(getA(c, 'b').fadeInSec).toBe(1)
    const d = setTransitionLength(c, 'A', 'out', 0.25)
    expect(get(d, 'B').startSec).toBe(3.75)
    expect(get(d, 'C').startSec).toBe(7.75)
    expect(pairOf(d.layers, 'A', 'out')?.sec).toBe(0.25)
  })

  it('a length change leaves a fade the user changed alone', () => {
    const c0 = applied()
    const edited = { ...c0, audioClips: c0.audioClips.map((a) => (a.id === 'a' ? { ...a, fadeOutSec: 1.2 } : a)) }
    const c = setTransitionLength(edited, 'B', 'in', 1)
    expect(getA(c, 'a').fadeOutSec).toBe(1.2)
    expect(getA(c, 'b').fadeInSec).toBe(1)
  })

  it('is held to 0.1 s … half the shorter clip (and 2 s)', () => {
    expect(get(setTransitionLength(applied(), 'B', 'in', 9), 'B').transitionIn?.sec).toBe(2)
    expect(get(setTransitionLength(applied(), 'B', 'in', 0), 'B').transitionIn?.sec).toBe(0.1)
    expect(maxSideSec(applied(), 'B', 'in')).toBe(2)
  })

  it('removal takes both sides off and leaves the overlap', () => {
    const c = removeTransition(applied(), 'B', 'in')
    expect('transitionOut' in get(c, 'A')).toBe(false)
    expect('transitionIn' in get(c, 'B')).toBe(false)
    expect(get(c, 'B').startSec).toBe(3.5)
    expect(getA(c, 'b').fadeInSec).toBe(0.5)
  })

  it('a pair switches kind together; a fade breaks the pair', () => {
    const c = setTransitionKind(applied(), 'A', 'out', 'dipWhite')
    expect(get(c, 'A').transitionOut).toEqual(tr('dipWhite', 0.5))
    expect(get(c, 'B').transitionIn).toEqual(tr('dipWhite', 0.5))
    const d = setTransitionKind(c, 'B', 'in', 'fade')
    expect(get(d, 'B').transitionIn).toEqual(tr('fade', 0.5))
    expect('transitionOut' in get(d, 'A')).toBe(false)
  })

  it('a fade at a clip’s end: set, held to half the clip, removed with 0; a paired side is left alone', () => {
    const c = setFade(reel(), 'C', 'out', 1)
    expect(get(c, 'C').transitionOut).toEqual(tr('fade', 1))
    expect(get(setFade(c, 'C', 'out', 9), 'C').transitionOut).toEqual(tr('fade', 2))
    expect('transitionOut' in get(setFade(c, 'C', 'out', 0), 'C')).toBe(false)
    const p = applied()
    expect(setFade(p, 'B', 'in', 1)).toBe(p)
    // A fade length is a lone side: no slide.
    expect(get(setTransitionLength(c, 'C', 'out', 1.5), 'C')).toMatchObject({
      startSec: 8,
      transitionOut: tr('fade', 1.5)
    })
  })
})

describe('the ripple pieces', () => {
  it('shiftFrom moves the group and everything after the point as one set, or nothing when it would pass 0', () => {
    const c = shiftFrom(reel(), 4, -0.5, [L('B'), { kind: 'audio', id: 'b' }])
    expect(get(c, 'B').startSec).toBe(3.5)
    expect(get(c, 'A').startSec).toBe(0)
    const tooFar = reel()
    expect(shiftFrom(tooFar, 4, -5, [L('B')])).toBe(tooFar)
  })

  it('placeAbove moves the upper tile directly above the lower one', () => {
    const c = comp([video('B', 4, 4), makeTextLayer('T', 0, 9), video('A', 0, 4)])
    expect(placeAbove(c, 'A', 'B').layers.map((l) => l.id)).toEqual(['T', 'A', 'B'])
  })
})
