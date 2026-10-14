import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type CaptionSegment, type Composition } from '../project'
import { makeTextLayer, makeVideoLayer } from '../layers'
import { summarizeText } from './onScreenText'

const cap = (over: Partial<CaptionSegment>): CaptionSegment => ({
  id: 'c1',
  startSec: 2,
  endSec: 3,
  text: 'hello there',
  words: [],
  enabled: true,
  ...over
})

function comp(): Composition {
  const base = createEmptyComposition()
  const title = makeTextLayer('t1', 1, 4)
  return {
    ...base,
    layers: [makeVideoLayer('v', 'm1', 0, 10), { ...title, content: { ...title.content, text: 'Title' } as typeof title.content }],
    captions: {
      ...base.captions,
      enabled: true,
      segments: [cap({}), cap({ id: 'c2', startSec: 1, endSec: 2, style: { ...base.captions.style, color: '#ff0000' } })]
    }
  }
}

const unlinked = (): boolean => false

describe('summarizeText', () => {
  it('lists text layers and captions in timeline order, text first on a tie, and skips other layers', () => {
    const s = summarizeText(comp(), unlinked, 10)
    expect(s.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['text:t1', 'caption:c2', 'caption:c1'])
    expect(s.items[0]).toMatchObject({ text: 'Title', startSec: 1, endSec: 4, visible: true, scale: 1, rotationDeg: 0 })
  })

  it('reports the style a caption actually renders with and where it comes from', () => {
    const s = summarizeText(comp(), unlinked, 10)
    const c1 = s.items.find((i) => i.id === 'c1')!
    const c2 = s.items.find((i) => i.id === 'c2')!
    expect(c1).toMatchObject({ styleFrom: 'lane', color: s.captionLane.color })
    expect(c2).toMatchObject({ styleFrom: 'own', color: '#ff0000' })
    expect(s.captionLane).toMatchObject({ id: 'captions', visible: true })
  })

  it('says why an item is not visible', () => {
    const c = comp()
    c.layers[1] = { ...c.layers[1], hidden: true }
    c.captions = { ...c.captions, enabled: false, segments: [cap({}), cap({ id: 'c3', enabled: false })] }
    const s = summarizeText(c, unlinked, 10)
    expect(s.items.map((i) => [i.id, i.visible, i.hiddenBecause])).toEqual([
      ['t1', false, 'layer hidden'],
      ['c1', false, 'caption lane off'],
      ['c3', false, 'caption disabled']
    ])
  })

  it('filters by ids and by what is on screen in a range; a point range asks what shows at t', () => {
    const c = comp()
    expect(summarizeText(c, unlinked, 10, { ids: ['c1'] }).items.map((i) => i.id)).toEqual(['c1'])
    expect(summarizeText(c, unlinked, 10, { fromSec: 2, toSec: 2 }).items.map((i) => i.id)).toEqual(['t1', 'c1'])
    expect(summarizeText(c, unlinked, 10, { fromSec: 4.5 }).items).toEqual([])
  })

  it('a caption at or after the end of the edit never shows; one straddling it is cut off', () => {
    const c = comp()
    c.captions = { ...c.captions, segments: [cap({ id: 'late', startSec: 10, endSec: 11 }), cap({ id: 'edge', startSec: 9, endSec: 10.5 })] }
    const s = summarizeText(c, unlinked, 10)
    expect(s.durationSec).toBe(10)
    expect(s.items.find((i) => i.id === 'late')).toMatchObject({ visible: false, hiddenBecause: 'after the end of the edit' })
    expect(s.items.find((i) => i.id === 'edge')).toMatchObject({ visible: true, cutOffAtSec: 10 })
    expect(s.items.find((i) => i.id === 'edge')!.hiddenBecause).toBeUndefined()
  })

  it('marks linked items using the caller-supplied link test', () => {
    const s = summarizeText(comp(), (ref) => ref.kind === 'caption' && ref.id === 'c1', 10)
    expect(s.items.find((i) => i.id === 'c1')!.linked).toBe(true)
    expect(s.items.find((i) => i.id === 't1')!.linked).toBe(false)
  })
})
