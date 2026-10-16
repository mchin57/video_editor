import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type VideoContent } from '@shared/project'
import { centeredFrame } from '@shared/frame'
import { makeImageLayer, makeTextLayer, makeVideoLayer, playedVideoDuration } from '@shared/layers'
import type { SequenceItem } from '@shared/assistant/protocol'
import { applySequence } from './sequence'

const ctx = (autoJoinLevel = false) => {
  let n = 0
  return { frame: centeredFrame(1080, 1920), newId: () => `id${++n}`, autoJoinLevel }
}
const item = (mediaId: string, inSec: number, outSec: number, extra: Partial<SequenceItem> = {}): SequenceItem => ({
  mediaId,
  inSec,
  outSec,
  sourceDurationSec: 20,
  hasAudio: true,
  aspect: 9 / 16,
  ...extra
})
const content = (l: { content: unknown }) => l.content as VideoContent

describe('applySequence', () => {
  it('lays items end-to-end in the given order from 0 on an empty timeline', () => {
    const { comp, placed } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 2, 5), item('b', 10, 11.5)] }, ctx())
    expect(placed.map((p) => [p.mediaId, p.startSec, p.endSec])).toEqual([['a', 0, 3], ['b', 3, 4.5]])
    expect(comp.layers.map((l) => [content(l).inSec, content(l).outSec])).toEqual([[2, 5], [10, 11.5]])
  })

  it("keeps every layer's window equal to its played duration", () => {
    const { comp } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 1.25, 7.5), item('b', 0, 3)] }, ctx())
    for (const l of comp.layers) expect(l.endSec - l.startSec).toBeCloseTo(playedVideoDuration(content(l)), 9)
  })

  it('appends after the current end of the timeline', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    const { placed } = applySequence(first, { mode: 'append', items: [item('b', 0, 2)] }, ctx())
    expect(placed[0]).toMatchObject({ startSec: 3, endSec: 5 })
  })

  it('starts at atSec when given', () => {
    const { placed } = applySequence(createEmptyComposition(), { mode: 'append', atSec: 7, items: [item('a', 0, 1)] }, ctx())
    expect(placed[0]).toMatchObject({ startSec: 7, endSec: 8 })
  })

  it('replace removes existing video clips and their linked audio, keeps other layers, and starts at 0', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    const withImage = { ...first, layers: [...first.layers, makeImageLayer('img', 'pic', 0, 2)] }
    const { comp, placed } = applySequence(withImage, { mode: 'replace', items: [item('b', 0, 2)] }, ctx())
    expect(comp.layers.map((l) => l.content.kind).sort()).toEqual(['image', 'video'])
    expect(comp.audioClips.map((a) => a.mediaId)).toEqual(['b'])
    expect(placed[0]).toMatchObject({ mediaId: 'b', startSec: 0 })
  })

  it('clamps in/out to the source when out overshoots by a rounding margin', () => {
    const { placed } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', -1, 20.4)] }, ctx())
    expect(placed[0]).toMatchObject({ inSec: 0, outSec: 20, startSec: 0, endSec: 20 })
  })

  // #17: outSec 60 or 5000 (ms) on a short clip used to clamp silently.
  for (const outSec of [60, 5000]) {
    it(`refuses outSec ${outSec} on a 20 s source, saying times are in seconds`, () => {
      const start = createEmptyComposition()
      expect(() => applySequence(start, { mode: 'append', items: [item('a', 0, outSec)] }, ctx())).toThrow(
        /item 0 \(a\): outSec .* past the end of the 20\.00s source; times are in seconds/
      )
      expect(start.layers).toEqual([])
    })
  }

  // #8: atSec 1e9 was accepted and the export then encoded ~forever.
  it('refuses an atSec more than 60 s past the end of the edit', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    for (const atSec of [1e9, 5000, 63.01]) {
      expect(() => applySequence(first, { mode: 'append', atSec, items: [item('b', 0, 1)] }, ctx())).toThrow(
        /more than 60s past the end of the edit \(3s\); times are in seconds/
      )
    }
    expect(applySequence(first, { mode: 'append', atSec: 63, items: [item('b', 0, 1)] }, ctx()).placed[0].startSec).toBe(63)
  })

  it('measures the atSec bound after replace removes the old video', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 20)] }, ctx()).comp
    expect(() => applySequence(first, { mode: 'replace', atSec: 70, items: [item('b', 0, 1)] }, ctx())).toThrow(/past the end/)
  })

  it('rejects an item that clamps to (almost) nothing, naming it', () => {
    expect(() => applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 1), item('b', 25, 30)] }, ctx())).toThrow(/item 1 \(b\)/)
  })

  it('rejects a reversed item without touching the input composition', () => {
    const start = createEmptyComposition()
    expect(() => applySequence(start, { mode: 'append', items: [item('a', 5, 2)] }, ctx())).toThrow(/item 0/)
    expect(start.layers).toEqual([])
  })

  it('links a matching extracted audio clip for sources with audio', () => {
    const { comp } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 2, 5)] }, ctx())
    const [layer] = comp.layers
    const [clip] = comp.audioClips
    expect(content(layer).mute).toBe(true)
    expect(clip).toMatchObject({ mediaId: 'a', startSec: layer.startSec, inSec: 2, outSec: 5, kind: 'extracted' })
    expect(clip.linkGroupId).toBeDefined()
    expect(clip.linkGroupId).toBe(layer.linkGroupId)
  })

  it('adds no audio and leaves the clip unmuted when the source is silent', () => {
    const { comp } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 2, { hasAudio: false })] }, ctx())
    expect(comp.audioClips).toEqual([])
    expect(content(comp.layers[0]).mute).toBe(false)
    expect(comp.layers[0].linkGroupId).toBeUndefined()
  })
})

// `layers` is back→front. Added clips go on top, like a library drag; only
// `replace` reuses the slot of the video it removed.
describe('applySequence stacking', () => {
  const kinds = (c: { layers: { content: { kind: string } }[] }) => c.layers.map((l) => l.content.kind)

  it('append puts new clips on the top layer, over an existing text layer', () => {
    const start = { ...createEmptyComposition(), layers: [makeTextLayer('title', 0, 5)] }
    const { comp, placed } = applySequence(start, { mode: 'append', atSec: 0, items: [item('a', 0, 2), item('b', 0, 2)] }, ctx())
    expect(kinds(comp)).toEqual(['text', 'video', 'video'])
    expect(comp.layers.slice(1).map((l) => l.id)).toEqual(placed.map((p) => p.layerId))
  })

  it('replace that removes no video puts new clips on the top layer', () => {
    const start = { ...createEmptyComposition(), layers: [makeImageLayer('img', 'pic', 0, 3)] }
    const { comp, placed } = applySequence(start, { mode: 'replace', items: [item('b', 0, 2)] }, ctx())
    expect(comp.layers.map((l) => l.id)).toEqual(['img', placed[0].layerId])
  })

  it('replace keeps a title in front and puts the new clips where the old video was', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    const withTitle = { ...first, layers: [...first.layers, makeTextLayer('title', 0, 3)] }
    const { comp, placed } = applySequence(withTitle, { mode: 'replace', items: [item('b', 0, 2), item('c', 0, 2)] }, ctx())
    expect(kinds(comp)).toEqual(['video', 'video', 'text'])
    expect(comp.layers[comp.layers.length - 1].id).toBe('title')
    expect(comp.layers.slice(0, 2).map((l) => l.id)).toEqual(placed.map((p) => p.layerId))
  })

  it('replace slots the new clips at the bottom-most removed video, under surviving layers above it', () => {
    const start = {
      ...createEmptyComposition(),
      layers: [makeImageLayer('under', 'pic', 0, 2), makeVideoLayer('v1', 'x', 0, 2), makeImageLayer('over', 'pic', 0, 2), makeVideoLayer('v2', 'y', 0, 2)]
    }
    const { comp, placed } = applySequence(start, { mode: 'replace', items: [item('b', 0, 2)] }, ctx())
    expect(comp.layers.map((l) => l.id)).toEqual(['under', placed[0].layerId, 'over'])
  })

  it('append puts new clips on the top layer, above every existing video and image', () => {
    const ids = ctx()
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ids).comp
    const withImage = { ...first, layers: [...first.layers, makeImageLayer('img', 'pic', 0, 3)] }
    const { comp, placed } = applySequence(withImage, { mode: 'append', items: [item('b', 0, 2), item('c', 0, 2)] }, ids)
    expect(comp.layers.map((l) => l.id)).toEqual([first.layers[0].id, 'img', ...placed.map((p) => p.layerId)])
  })
})

describe('applySequence auto-join (volume levels)', () => {
  it('puts the extracted audio in Default when auto-join is on, and in no level when off', () => {
    const on = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 2)] }, ctx(true)).comp
    expect(on.audioClips).toHaveLength(1)
    expect(on.audioClips[0]).toMatchObject({ kind: 'extracted', volumeLevelId: 'default' })
    const off = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 2)] }, ctx(false)).comp
    expect(off.audioClips[0].volumeLevelId).toBeUndefined()
  })
})
