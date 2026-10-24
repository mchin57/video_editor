/**
 * Dropping a template at the playhead (`applyTemplate`) and saving one from the
 * selection (`templateFromSelection`): the held frame is ONE source frame plus
 * a freeze at its end, only it is zoomed/graded and silent, the clip resumes
 * after the hold, everything after the drop point moves later by the hold, and
 * the dropped pieces land as one link group.
 */
import { describe, expect, it } from 'vitest'
import { makeVideoLayer, playedVideoDuration, videoSourceTime } from '@shared/layers'
import {
  createEmptyComposition,
  type AudioClip,
  type Composition,
  type Layer,
  type VideoContent
} from '@shared/project'
import { BUILT_IN_TEMPLATES } from '@shared/templateStarters'
import { TEMPLATE_FORMAT_VERSION, type ReelTemplate } from '@shared/templates'
import { HOLD_FRAME_SEC, applyTemplate, clipUnder, templateFromSelection } from './templates'
import { expandGroup } from './links'

let n = 0
const makeId = (): string => `id${++n}`
const srcDur = (): number => 0

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

const vid = (c: Composition, id: string): Layer & { content: VideoContent } =>
  c.layers.find((l) => l.id === id) as Layer & { content: VideoContent }

describe('applyTemplate — the clip effect', () => {
  it('holds the frame under the playhead and the clip resumes after the hold', () => {
    const { comp, added, effectSkipped } = applyTemplate(edit(), tpl(), 4, srcDur, makeId)
    expect(effectSkipped).toBe(false)
    const heldId = added[0].id
    const held = vid(comp, heldId)
    // Left of the drop point: the original clip, cut at 4s.
    const left = vid(comp, 'V')
    expect([left.startSec, left.endSec, left.content.inSec, left.content.outSec]).toEqual([0, 4, 0, 4])
    // The held piece: one source frame from 4s, then a freeze on its last frame.
    expect(held.startSec).toBe(4)
    expect(held.endSec).toBeCloseTo(7 + HOLD_FRAME_SEC, 6)
    expect(held.content.inSec).toBeCloseTo(4, 6)
    expect(held.content.outSec).toBeCloseTo(4 + HOLD_FRAME_SEC, 6)
    expect(held.content.freezes).toEqual([{ atSec: held.content.outSec, holdSec: 3 }])
    expect(playedVideoDuration(held.content)).toBeCloseTo(3 + HOLD_FRAME_SEC, 6)
    // It shows the frame at the drop point the whole time.
    expect(videoSourceTime(held.content, held, 6.9)).toBeCloseTo(4 + HOLD_FRAME_SEC, 3)
    // Only it is graded, tinted, silent; the rest of the clip keeps its look.
    expect(held.content.mute).toBe(true)
    expect(held.content.color).toEqual(fx.color)
    expect(held.content.tint).toEqual(fx.tint)
    expect(left.content.tint).toBeUndefined()
    // The rest of the clip resumes at the frame after the held one, after the hold.
    const rest = comp.layers.find((l) => l.content.kind === 'video' && l.id !== 'V' && l.id !== heldId)!
    expect(rest.startSec).toBeCloseTo(7 + HOLD_FRAME_SEC, 6)
    expect((rest.content as VideoContent).inSec).toBeCloseTo(4 + HOLD_FRAME_SEC, 6)
    expect(rest.content.kind === 'video' && rest.content.tint).toBeFalsy()
  })

  it('zooms the held frame from where it was to the template zoom across the hold', () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 4, srcDur, makeId)
    const held = vid(comp, added[0].id)
    expect(held.keyframes).toEqual([
      { tSec: 0, x: 540, y: 960, scale: 1 },
      { tSec: expect.closeTo(3 + HOLD_FRAME_SEC, 6), x: 550, y: 940, scale: 1.5 }
    ])
  })

  it("keeps the clip's own audio in sync: cut, a one-frame sliver dropped, the rest moved by the hold", () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 4, srcDur, makeId)
    const clipAudio = comp.audioClips.filter((a) => a.mediaId === 'clip').sort((a, b) => a.startSec - b.startSec)
    expect(clipAudio).toHaveLength(2)
    expect([clipAudio[0].startSec, clipAudio[0].outSec]).toEqual([0, 4])
    expect(clipAudio[1].startSec).toBeCloseTo(7 + HOLD_FRAME_SEC, 6)
    expect(clipAudio[1].inSec).toBeCloseTo(4 + HOLD_FRAME_SEC, 6)
    // The resumed clip and its audio stay linked to each other, not to the template.
    const rest = comp.layers.find((l) => l.content.kind === 'video' && l.id !== 'V' && l.id !== added[0].id)!
    const restGroup = expandGroup(comp, { kind: 'layer', id: rest.id }).map((r) => r.id)
    expect(restGroup).toEqual([rest.id, clipAudio[1].id])
  })

  it('moves everything after the drop point later by exactly the hold and leaves what crosses it alone', () => {
    const { comp } = applyTemplate(edit(), tpl(), 4, srcDur, makeId)
    const late = comp.layers.find((l) => l.id === 'late')!
    expect(late.startSec).toBeCloseTo(11, 6)
    expect(late.endSec).toBeCloseTo(12, 6)
    expect(comp.audioClips.find((a) => a.id === 'bed')!.startSec).toBe(0)
  })

  it('works at the very start of a clip (no first cut)', () => {
    const { comp, added } = applyTemplate(edit(), tpl(), 0, srcDur, makeId)
    expect(added[0].id).toBe('V')
    const held = vid(comp, 'V')
    expect([held.startSec, held.content.inSec]).toEqual([0, 0])
    expect(held.endSec).toBeCloseTo(3 + HOLD_FRAME_SEC, 6)
  })

  it('without a clip under the playhead drops only the overlays, and says so', () => {
    const before = edit()
    const { comp, effectSkipped, added } = applyTemplate(before, tpl(), 15, srcDur, makeId)
    expect(effectSkipped).toBe(true)
    expect(comp.layers.filter((l) => l.content.kind === 'video')).toEqual(
      before.layers.filter((l) => l.content.kind === 'video')
    )
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
    const { comp, added } = applyTemplate(edit(), tpl(), 4, srcDur, makeId)
    const title = comp.layers.at(-1)!
    expect(title.content.kind).toBe('text')
    expect([title.startSec, title.endSec]).toEqual([4.3, 7])
    const sting = comp.audioClips.find((a) => a.mediaId === 'sting-media')!
    expect([sting.startSec, sting.outSec, sting.gainDb]).toEqual([4, 2, -3])
    expect(comp.audioClips.filter((a) => a.mediaId === '' || a.mediaId === null)).toHaveLength(0)
    expect(added).toHaveLength(3)
    const group = expandGroup(comp, added[0])
      .map((r) => r.id)
      .sort()
    expect(group).toEqual(added.map((r) => r.id).sort())
  })

  it('gives every dropped piece a fresh id, so dropping twice never collides', () => {
    const once = applyTemplate(createEmptyComposition(), tpl({ clipEffect: null }), 1, srcDur, makeId)
    const twice = applyTemplate(once.comp, tpl({ clipEffect: null }), 5, srcDur, makeId)
    const ids = twice.comp.layers.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('drops every built-in starter onto an empty edit', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      const { comp, effectSkipped } = applyTemplate(createEmptyComposition(), t, 2, srcDur, makeId)
      expect(comp.layers.length).toBe(t.layers.length)
      expect(effectSkipped).toBe(!!t.clipEffect)
      for (const l of comp.layers) expect(l.startSec).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('templateFromSelection', () => {
  it('saves a dropped template back to the same pieces and clip effect', () => {
    const t = tpl()
    const { comp, added } = applyTemplate(edit(), t, 4, srcDur, makeId)
    const got = templateFromSelection(comp, added, '  My   bit ', 'new', () => 'Sting')
    if ('error' in got) throw new Error(got.error)
    expect(got.skipped).toEqual([])
    expect(got.template.name).toBe('My bit')
    expect(got.template.id).toBe('new')
    const e = got.template.clipEffect!
    expect(e).toEqual({
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
    expect(templateFromSelection(c, [{ kind: 'layer', id: 'V' }], 'x', 'i', () => '')).toEqual({
      error: 'Select text, graphics, images, sounds or a frozen clip to save as a template.'
    })
    expect(templateFromSelection(c, [{ kind: 'layer', id: 'late' }], '   ', 'i', () => '')).toEqual({
      error: 'Give the template a name.'
    })
  })
})
