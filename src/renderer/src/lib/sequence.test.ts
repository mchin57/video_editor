import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type VideoContent } from '@shared/project'
import { centeredFrame } from '@shared/frame'
import { makeImageLayer, makeTextLayer, makeVideoLayer, playedVideoDuration } from '@shared/layers'
import type { SequenceItem } from '@shared/assistant/protocol'
import { applySequence } from './sequence'

const ctx = () => {
  let n = 0
  return { frame: centeredFrame(1080, 1920), newId: () => `id${++n}` }
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

  it('clamps in/out to the source', () => {
    const { placed } = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', -1, 99)] }, ctx())
    expect(placed[0]).toMatchObject({ inSec: 0, outSec: 20, startSec: 0, endSec: 20 })
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

// `layers` is back→front, so where the new clips go decides whether they bury titles.
describe('applySequence stacking', () => {
  const kinds = (c: { layers: { content: { kind: string } }[] }) => c.layers.map((l) => l.content.kind)

  it('puts new clips behind an existing text layer when no video exists', () => {
    const start = { ...createEmptyComposition(), layers: [makeTextLayer('title', 0, 5)] }
    const { comp } = applySequence(start, { mode: 'append', atSec: 0, items: [item('a', 0, 2), item('b', 0, 2)] }, ctx())
    expect(kinds(comp)).toEqual(['video', 'video', 'text'])
    expect(comp.layers[comp.layers.length - 1].id).toBe('title')
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

  it('append inserts directly above the topmost video and below an image above it', () => {
    const first = applySequence(createEmptyComposition(), { mode: 'append', items: [item('a', 0, 3)] }, ctx()).comp
    const withImage = { ...first, layers: [...first.layers, makeImageLayer('img', 'pic', 0, 3)] }
    const { comp, placed } = applySequence(withImage, { mode: 'append', items: [item('b', 0, 2), item('c', 0, 2)] }, ctx())
    expect(kinds(comp)).toEqual(['video', 'video', 'video', 'image'])
    expect(comp.layers[comp.layers.length - 1].id).toBe('img')
    expect(comp.layers.slice(1, 3).map((l) => l.id)).toEqual(placed.map((p) => p.layerId))
    expect(comp.layers[0].id).toBe(first.layers[0].id)
  })
})
