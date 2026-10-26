/**
 * Dropping a template at the playhead (`applyTemplate`) and saving one from the
 * selection (`templateFromSelection`): the held frame is a couple of SOURCE
 * frames held at their head, only it is zoomed/graded and silent, the clip
 * resumes after the hold, everything from the drop point on moves later by
 * exactly the hold, and the dropped pieces land as one link group. Includes the
 * audit's regressions: a drop at a clip start never deletes linked pieces before
 * it, a drop inside a hold never makes a zero-length source, the held piece
 * follows the clip's frame rate and speed.
 */
import { describe, expect, it } from 'vitest'
import { makeVideoLayer, makeWorkoutLayer, playedVideoDuration, videoSourceTime } from '@shared/layers'
import {
  createEmptyComposition,
  type AudioClip,
  type Composition,
  type Layer,
  type VideoContent
} from '@shared/project'
import { BUILT_IN_TEMPLATES } from '@shared/templateStarters'
import { TEMPLATE_FORMAT_VERSION, type ReelTemplate } from '@shared/templates'
import { HELD_SOURCE_FRAMES, applyTemplate, clipUnder, templateFromSelection, type DropMedia } from './templates'
import { expandGroup } from './links'

let n = 0
const makeId = (): string => `id${++n}`
/** No durations known; every clip at 30 fps (the fallback too). */
const media: DropMedia = { durationOf: () => 0, fpsOf: () => 30 }
/** Two source frames at 30 fps. */
const F = HELD_SOURCE_FRAMES / 30

function sound(id: string, startSec: number, dur: number, extra: Partial<AudioClip> = {}): AudioClip {
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
    ...extra
  }
}

function text(id: string, startSec: number, endSec: number): Layer {
  return {
    id,
    hidden: false,
    startSec,
    endSec,
    x: 540,
    y: 600,
    scale: 1,
    content: {
      kind: 'text',
      text: id,
      fontFamily: 'anton',
      fontSizePx: 80,
      color: '#ffffff',
      pill: { enabled: false, color: '#000000', padPx: 10 }
    }
  }
}

/** A 10s clip at 0 linked to its own 10s audio, a later text layer at 8s and a
 *  music bed under everything from 0. */
function edit(): Composition {
  const v = { ...makeVideoLayer('V', 'clip', 0, 10), linkGroupId: 'g' }
  return {
    ...createEmptyComposition(),
    layers: [v, text('late', 8, 9)],
    audioClips: [sound('A', 0, 10, { mediaId: 'clip', kind: 'extracted', linkGroupId: 'g' }), sound('bed', 0, 20)]
  }
}

const fx = {
  holdSec: 3,
  zoom: { scale: 1.5, dx: 10, dy: -20 },
  color: { brightness: 0, contrast: 1.1, saturation: 0.5 },
  tint: { color: '#e8c290', amount: 0.6 }
}

function tpl(over: Partial<ReelTemplate> = {}): ReelTemplate {
  return {
    id: 't',
    name: 'T',
    formatVersion: TEMPLATE_FORMAT_VERSION,
    layers: [text('title', 0.3, 3)],
    audio: [
      {
        label: 'Sting',
        file: 'sting-media',
        clip: {
          startSec: 0,
          inSec: 0,
          outSec: 2,
          gainDb: -3,
          fadeInSec: 0,
          fadeOutSec: 0.3,
          duck: false,
          kind: 'music'
        }
      },
      {
        label: 'Empty',
        file: null,
        clip: { startSec: 0, inSec: 0, outSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false, kind: 'music' }
      }
    ],
    clipEffect: fx,
    ...over
  }
}

type VideoLayer = Layer & { content: VideoContent }
const vid = (c: Composition, id: string): VideoLayer => c.layers.find((l) => l.id === id) as VideoLayer
const videos = (c: Composition): VideoLayer[] =>
  (c.layers.filter((l) => l.content.kind === 'video') as VideoLayer[]).sort((a, b) => a.startSec - b.startSec)

describe('applyTemplate — the clip effect', () => {
  it('holds the frame under the playhead and the clip resumes after the hold', () => {
    const { comp, added, effectSkipped } = applyTemplate(edit(), tpl(), 4, media, makeId)
    expect(effectSkipped).toBe(false)
    const [left, held, rest] = videos(comp)
    expect(held.id).toBe(added[0].id)
    expect([left.id, left.startSec, left.endSec, left.content.inSec, left.content.outSec]).toEqual(['V', 0, 4, 0, 4])
    // The held piece: two source frames from 4s, held at their head for 3s.
    expect(held.startSec).toBe(4)
    expect(held.content.inSec).toBeCloseTo(4, 6)
    expect(held.content.outSec).toBeCloseTo(4 + F, 6)
    expect(held.content.freezes).toEqual([{ atSec: held.content.inSec, holdSec: 3 }])
    expect(held.endSec).toBeCloseTo(7 + F, 6)
    expect(playedVideoDuration(held.content)).toBeCloseTo(3 + F, 6)
    // The frame at the drop point is what it shows across the hold.
    for (const t of [4.01, 5.5, 6.99]) expect(videoSourceTime(held.content, held, t)).toBeCloseTo(4, 6)
    // Only it is graded, tinted, silent; the rest of the clip keeps its look.
    expect(held.content.mute).toBe(true)
    expect(held.content.color).toEqual(fx.color)
    expect(held.content.tint).toEqual(fx.tint)
    expect(left.content.tint).toBeUndefined()
    expect(rest.startSec).toBeCloseTo(7 + F, 6)
    expect(rest.content.inSec).toBeCloseTo(4 + F, 6)
    expect(rest.content.tint).toBeUndefined()
  })

  it('zooms the held frame from where it was to the template zoom across the hold', () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 4, media, makeId)
    expect(vid(comp, added[0].id).keyframes).toEqual([
      { tSec: 0, x: 540, y: 960, scale: 1 },
      { tSec: 3, x: 550, y: 940, scale: 1.5 }
    ])
  })

  it('cuts the held piece by the CLIP’s frame rate', () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 4, { ...media, fpsOf: () => 24 }, makeId)
    const held = vid(comp, added[0].id)
    expect(held.content.outSec - held.content.inSec).toBeCloseTo(HELD_SOURCE_FRAMES / 24, 6)
  })

  it("keeps the clip's own audio in sync: cut, the sliver under the held frames dropped, the rest moved by the hold", () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 4, media, makeId)
    const clipAudio = comp.audioClips.filter((a) => a.mediaId === 'clip').sort((a, b) => a.startSec - b.startSec)
    expect(clipAudio).toHaveLength(2)
    expect([clipAudio[0].startSec, clipAudio[0].outSec]).toEqual([0, 4])
    expect(clipAudio[1].startSec).toBeCloseTo(7 + F, 6)
    expect(clipAudio[1].inSec).toBeCloseTo(4 + F, 6)
    // The resumed clip and its audio stay linked to each other, not to the template.
    const rest = videos(comp)[2]
    expect(expandGroup(comp, { kind: 'layer', id: rest.id }).map((r) => r.id)).toEqual([rest.id, clipAudio[1].id])
    expect(expandGroup(comp, added[0]).map((r) => r.id)).not.toContain(rest.id)
  })

  it('moves everything from the drop point on later by exactly the hold, and leaves what crosses it alone', () => {
    const c = edit()
    c.layers.push(text('atCut', 4, 5)) // a title aligned to the drop point
    const { comp } = applyTemplate(c, tpl(), 4, media, makeId)
    expect(comp.layers.find((l) => l.id === 'late')).toMatchObject({ startSec: 11, endSec: 12 })
    expect(comp.layers.find((l) => l.id === 'atCut')).toMatchObject({ startSec: 7, endSec: 8 })
    expect(comp.audioClips.find((a) => a.id === 'bed')!.startSec).toBe(0)
  })

  it('works at the very start of a clip (no first cut)', () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 0, media, makeId)
    expect(added[0].id).toBe('V')
    const held = vid(comp, 'V')
    expect([held.startSec, held.content.inSec]).toEqual([0, 0])
    expect(held.endSec).toBeCloseTo(3 + F, 6)
  })

  it('at a clip start, never deletes a linked piece that reaches back before the drop point (J-cut)', () => {
    // The clip starts at 5s; its linked audio starts 2s earlier (a J-cut) and a
    // linked title runs 3s–6s.
    const v = { ...makeVideoLayer('V', 'clip', 5, 5), linkGroupId: 'g' }
    const c: Composition = {
      ...createEmptyComposition(),
      layers: [{ ...text('title', 3, 6), linkGroupId: 'g' }, v],
      audioClips: [sound('A', 3, 7, { mediaId: 'clip', kind: 'extracted', linkGroupId: 'g' })]
    }
    const { comp } = applyTemplate(c, tpl({ layers: [], audio: [] }), 5, media, makeId)
    // Everything before the drop point is still there.
    const audio = comp.audioClips.filter((a) => a.mediaId === 'clip').sort((a, b) => a.startSec - b.startSec)
    expect([audio[0].startSec, audio[0].outSec]).toEqual([3, 2])
    const titles = comp.layers.filter((l) => l.content.kind === 'text').sort((a, b) => a.startSec - b.startSec)
    expect(titles[0]).toMatchObject({ startSec: 3, endSec: 5 })
    // Only the two-frame slivers between the cuts went; their tails moved past the hold.
    expect(titles[1].startSec).toBeCloseTo(8 + F, 6)
    expect(audio[1].startSec).toBeCloseTo(8 + F, 6)
  })

  it('inside an existing freeze hold: never a zero-length source, and the timeline still grows by exactly the hold', () => {
    const v = makeVideoLayer('V', 'clip', 0, 10)
    const frozen: VideoLayer = {
      ...v,
      endSec: 12,
      content: { ...(v.content as VideoContent), freezes: [{ atSec: 3, holdSec: 2 }] }
    } // holds source 3s over timeline 3–5s
    const c = { ...createEmptyComposition(), layers: [frozen, text('late', 9, 10)] }
    const { comp, added } = applyTemplate(c, tpl({ layers: [], audio: [] }), 4, media, makeId)
    const held = vid(comp, added[0].id)
    expect(held.content.outSec - held.content.inSec).toBeCloseTo(F, 6)
    expect(held.content.inSec).toBe(3)
    // The rest of the old hold (1s) plus the new 3s, as one head hold.
    expect(held.content.freezes).toEqual([{ atSec: 3, holdSec: 4 }])
    expect(comp.layers.find((l) => l.id === 'late')!.startSec).toBeCloseTo(12, 6)
    expect(videos(comp).at(-1)!.endSec).toBeCloseTo(15, 6)
  })

  it('keeps a sped-up clip’s speed on the held piece, so the hold is all the timeline gains', () => {
    const v = makeVideoLayer('V', 'clip', 0, 10)
    const fast: VideoLayer = { ...v, endSec: 5, content: { ...(v.content as VideoContent), speed: 2 } }
    const c = { ...createEmptyComposition(), layers: [fast, text('late', 6, 7)] }
    const { comp, added } = applyTemplate(c, tpl({ layers: [], audio: [] }), 2, media, makeId)
    const held = vid(comp, added[0].id)
    expect(held.content.speed).toBe(2)
    expect(held.content.inSec).toBeCloseTo(4, 6) // timeline 2s at 2× = source 4s
    expect(held.content.outSec - held.content.inSec).toBeCloseTo(F, 6)
    expect(comp.layers.find((l) => l.id === 'late')!.startSec).toBeCloseTo(9, 6)
    expect(videos(comp).at(-1)!.endSec).toBeCloseTo(8, 6)
  })

  it('without a clip under the playhead drops only the overlays, and says so', () => {
    const before = edit()
    const { comp, effectSkipped, added } = applyTemplate(before, tpl(), 15, media, makeId)
    expect(effectSkipped).toBe(true)
    expect(videos(comp)).toEqual(videos(before))
    expect(added.map((r) => r.kind)).toEqual(['layer', 'audio'])
    expect(comp.layers.find((l) => l.id === 'late')!.startSec).toBe(8)
  })

  it('picks the front-most visible video under the playhead', () => {
    const c = edit()
    const top = makeVideoLayer('top', 'other', 2, 4)
    const hidden = { ...makeVideoLayer('hid', 'other', 2, 4), hidden: true }
    expect(clipUnder({ ...c, layers: [...c.layers, top, hidden] }, 3)!.id).toBe('top')
    expect(clipUnder(c, 10)).toBeNull()
  })
})

describe('applyTemplate — the overlays', () => {
  it('places layers and sounds from the drop point, skips an empty sound slot, and links them with the held frame', () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 4, media, makeId)
    const title = comp.layers.at(-1)!
    expect(title.content.kind).toBe('text')
    expect([title.startSec, title.endSec]).toEqual([4.3, 7])
    const sting = comp.audioClips.find((a) => a.mediaId === 'sting-media')!
    expect([sting.startSec, sting.outSec, sting.gainDb]).toEqual([4, 2, -3])
    expect(added).toHaveLength(3)
    const group = expandGroup(comp, added[0])
      .map((r) => r.id)
      .sort()
    expect(group).toEqual(added.map((r) => r.id).sort())
  })

  it('gives every dropped piece a fresh id, so dropping twice never collides', () => {
    const once = applyTemplate(createEmptyComposition(), tpl({ clipEffect: null }), 1, media, makeId)
    const twice = applyTemplate(once.comp, tpl({ clipEffect: null }), 5, media, makeId)
    const ids = twice.comp.layers.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('clips pieces timed before the drop point at the timeline start, trimming a sound’s head to stay in sync', () => {
    const early = tpl({
      clipEffect: null,
      layers: [text('pre', -2, 1), text('gone', -3, -1)],
      audio: [{ ...tpl().audio[0], clip: { ...tpl().audio[0].clip, startSec: -1.5, outSec: 3 } }]
    })
    const { comp } = applyTemplate(createEmptyComposition(), early, 1, media, makeId)
    expect(comp.layers.map((l) => [l.startSec, l.endSec])).toEqual([[0, 2]])
    expect(comp.audioClips.map((a) => [a.startSec, a.inSec, a.outSec])).toEqual([[0, 0.5, 3]])
  })

  it('drops every built-in starter onto an empty edit', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      const { comp, effectSkipped } = applyTemplate(createEmptyComposition(), t, 2, media, makeId)
      expect(comp.layers.length).toBe(t.layers.length)
      expect(effectSkipped).toBe(!!t.clipEffect)
      for (const l of comp.layers) expect(l.startSec).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('templateFromSelection', () => {
  it('saves a dropped template back to the same pieces and clip effect', () => {
    const t = tpl()
    const { comp, added } = applyTemplate(edit(), t, 4, media, makeId)
    const got = templateFromSelection(comp, added, '  My   bit ', 'new', () => 'Sting')
    if ('error' in got) throw new Error(got.error)
    expect(got.skipped).toEqual([])
    expect(got.template.name).toBe('My bit')
    expect(got.template.id).toBe('new')
    expect(got.template.clipEffect).toEqual({
      ...fx,
      zoom: { scale: expect.closeTo(1.5, 9), dx: expect.closeTo(10, 9), dy: expect.closeTo(-20, 9) }
    })
    expect(got.template.layers.map((l) => [l.content.kind, l.startSec, l.endSec])).toEqual([
      ['text', expect.closeTo(0.3, 9), expect.closeTo(3, 9)]
    ])
    expect(got.template.layers[0].linkGroupId).toBeUndefined()
    expect(got.template.audio).toEqual([
      {
        label: 'Sting',
        file: 'sting-media',
        clip: expect.objectContaining({ startSec: 0, outSec: 2, gainDb: -3 })
      }
    ])
  })

  it('times overlays from the earliest piece when no clip is frozen', () => {
    const c = {
      ...createEmptyComposition(),
      layers: [text('a', 5, 7), text('b', 6, 9)],
      audioClips: [sound('s', 5.5, 1)]
    }
    const got = templateFromSelection(
      c,
      [
        { kind: 'layer', id: 'a' },
        { kind: 'layer', id: 'b' },
        { kind: 'audio', id: 's' }
      ],
      'x',
      'i',
      () => 'Music'
    )
    if ('error' in got) throw new Error(got.error)
    expect(got.template.clipEffect).toBeNull()
    expect(got.template.layers.map((l) => l.startSec)).toEqual([0, 1])
    expect(got.template.audio[0].clip.startSec).toBe(0.5)
  })

  it('lists what it cannot carry, and refuses a selection with nothing to save', () => {
    const c = edit()
    const got = templateFromSelection(
      c,
      [
        { kind: 'layer', id: 'V' },
        { kind: 'audio', id: 'A' },
        { kind: 'layer', id: 'late' }
      ],
      'x',
      'i',
      () => ''
    )
    if ('error' in got) throw new Error(got.error)
    expect(got.skipped).toEqual(['video footage (add a freeze frame to save its effect)', "a clip's own audio"])
    // A workout overlay (selected with the clip it is synced to) is named as one.
    const withWorkout = {
      ...c,
      layers: [...c.layers, makeWorkoutLayer('W', 'fit', 0, { inSec: 0, outSec: 10, speed: 1 }, [])]
    }
    const got2 = templateFromSelection(
      withWorkout,
      [
        { kind: 'layer', id: 'W' },
        { kind: 'layer', id: 'late' }
      ],
      'x',
      'i',
      () => ''
    )
    if ('error' in got2) throw new Error(got2.error)
    expect(got2.skipped).toEqual(['a workout overlay'])
    expect(templateFromSelection(c, [{ kind: 'layer', id: 'V' }], 'x', 'i', () => '')).toEqual({
      error: 'Select text, graphics, images, sounds or a frozen clip to save as a template.'
    })
    expect(templateFromSelection(c, [{ kind: 'layer', id: 'late' }], '   ', 'i', () => '')).toEqual({
      error: 'Give the template a name.'
    })
  })
})
