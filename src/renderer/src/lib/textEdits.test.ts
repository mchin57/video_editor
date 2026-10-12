import { describe, expect, it } from 'vitest'
import { createEmptyComposition, type CaptionSegment, type Composition, type TextContent } from '@shared/project'
import { FULL_FRAME } from '@shared/frame'
import { makeTextLayer, makeVideoLayer } from '@shared/layers'
import { applyTextEdits, type TextEditCtx } from './textEdits'
import { captionInWindow, captionWithText } from './captions'
import { splitCaptionSegment } from './timeline'

const w = (text: string, startSec: number, endSec: number): { text: string; startSec: number; endSec: number } => ({
  text,
  startSec,
  endSec
})

const cap = (over: Partial<CaptionSegment> = {}): CaptionSegment => ({
  id: 'c1',
  startSec: 2,
  endSec: 4,
  text: 'helo wrld',
  words: [w('helo', 2, 2.8), w('wrld', 3, 3.8)],
  enabled: true,
  ...over
})

function comp(): Composition {
  const base = createEmptyComposition()
  return {
    ...base,
    layers: [makeVideoLayer('v', 'm1', 0, 10), makeTextLayer('t1', 1, 4)],
    captions: { ...base.captions, enabled: true, segments: [cap()] }
  }
}

function ctx(): TextEditCtx {
  let n = 0
  return { newId: () => `new${++n}`, frame: FULL_FRAME }
}

const textOf = (c: Composition, id: string): TextContent => c.layers.find((l) => l.id === id)!.content as TextContent

describe('captionWithText', () => {
  it('keeps each word timing when the word count is unchanged (a typo fix)', () => {
    const s = captionWithText(cap(), 'hello world')
    expect(s.text).toBe('hello world')
    expect(s.words).toEqual([w('hello', 2, 2.8), w('world', 3, 3.8)])
  })

  it('spreads a different number of words evenly over the span the old words covered', () => {
    const s = captionWithText(cap(), 'hello big world')
    expect(s.words.map((x) => x.text)).toEqual(['hello', 'big', 'world'])
    expect(s.words[0].startSec).toBeCloseTo(2)
    expect(s.words[2].endSec).toBeCloseTo(3.8)
    expect(s.words[1].startSec).toBeCloseTo(2.6)
  })

  it('uses the segment window when there were no words', () => {
    const s = captionWithText(cap({ words: [] }), 'one two')
    expect(s.words).toEqual([w('one', 2, 3), w('two', 3, 4)])
  })

  it('a fixed caption keeps the fix through a split (the bug this guards)', () => {
    const fixed = captionWithText(cap(), 'hello world')
    const halves = splitCaptionSegment(fixed, 2.9, () => 'c1b')!
    expect(halves.map((h) => h.text)).toEqual(['hello', 'world'])
  })
})

describe('captionInWindow', () => {
  it('maps word timings linearly into the new window', () => {
    const s = captionInWindow(cap(), 6, 10)
    expect([s.startSec, s.endSec]).toEqual([6, 10])
    expect(s.words).toEqual([w('helo', 6, 7.6), w('wrld', 8, 9.6)])
  })
})

describe('applyTextEdits', () => {
  it('creates a text layer on top when there is no id, with defaults for unset style', () => {
    const { comp: c, results } = applyTextEdits(comp(), [{ text: 'Day one', startSec: 0.5, endSec: 2 }], ctx())
    expect(results).toEqual([{ id: 'new1', kind: 'text', created: true }])
    const top = c.layers[c.layers.length - 1]
    expect(top).toMatchObject({ id: 'new1', startSec: 0.5, endSec: 2, hidden: false })
    expect(textOf(c, 'new1')).toMatchObject({ kind: 'text', text: 'Day one', fontSizePx: 76 })
  })

  it('creates a caption with spread words, sorted into the lane, styled from the lane when asked', () => {
    const { comp: c, results } = applyTextEdits(
      comp(),
      [{ kind: 'caption', text: 'first words', startSec: 0, endSec: 1, color: '#00ff00' }],
      ctx()
    )
    expect(results[0]).toEqual({ id: 'new1', kind: 'caption', created: true })
    const seg = c.captions.segments[0]
    expect(seg).toMatchObject({ id: 'new1', text: 'first words', enabled: true })
    expect(seg.words).toEqual([w('first', 0, 0.5), w('words', 0.5, 1)])
    expect(seg.style).toMatchObject({ ...c.captions.style, color: '#00ff00' })
  })

  it('notes that a new caption will not show while the lane is off', () => {
    const base = comp()
    base.captions = { ...base.captions, enabled: false }
    const { results } = applyTextEdits(base, [{ kind: 'caption', text: 'x', startSec: 0, endSec: 1 }], ctx())
    expect(results[0].note).toMatch(/caption lane is off/)
  })

  it('patches only the fields given, merging pill field by field', () => {
    const before = comp()
    const { comp: c } = applyTextEdits(before, [{ id: 't1', text: 'New title', pill: { enabled: true }, y: 300 }], ctx())
    const t = textOf(c, 't1')
    expect(t.text).toBe('New title')
    expect(t.pill).toEqual({ ...textOf(before, 't1').pill, enabled: true })
    expect(t.fontSizePx).toBe(textOf(before, 't1').fontSizePx)
    expect(c.layers.find((l) => l.id === 't1')!.y).toBe(300)
  })

  it('a caption text fix re-times its words; a style patch gives it its own style; followLaneStyle drops it', () => {
    let c = applyTextEdits(comp(), [{ id: 'c1', text: 'hello world', fontSizePx: 90 }], ctx()).comp
    let seg = c.captions.segments[0]
    expect(seg.words.map((x) => x.text)).toEqual(['hello', 'world'])
    expect(seg.style).toMatchObject({ fontSizePx: 90 })
    c = applyTextEdits(c, [{ id: 'c1', followLaneStyle: true }], ctx()).comp
    seg = c.captions.segments[0]
    expect(seg.style).toBeNull()
  })

  it('retimes a caption, carrying its words along', () => {
    const { comp: c } = applyTextEdits(comp(), [{ id: 'c1', startSec: 5, endSec: 7 }], ctx())
    expect(c.captions.segments[0].words[0]).toEqual(w('helo', 5, 5.8))
  })

  it('patches the caption lane through the reserved id', () => {
    const { comp: c, results } = applyTextEdits(comp(), [{ id: 'captions', visible: false, y: 1500, color: '#ffff00' }], ctx())
    expect(c.captions.enabled).toBe(false)
    expect(c.captions.style).toMatchObject({ y: 1500, color: '#ffff00' })
    expect(results[0]).toEqual({ id: 'captions', kind: 'captionLane', created: false })
  })

  it('applies a batch in order and hides/shows through visible', () => {
    const { comp: c, results } = applyTextEdits(
      comp(),
      [{ id: 't1', visible: false }, { id: 'c1', visible: false }, { text: 'more', startSec: 0, endSec: 1 }],
      ctx()
    )
    expect(results.map((r) => r.id)).toEqual(['t1', 'c1', 'new1'])
    expect(c.layers.find((l) => l.id === 't1')!.hidden).toBe(true)
    expect(c.captions.segments[0].enabled).toBe(false)
  })

  it('refuses the whole batch when any edit is bad, naming every problem', () => {
    const before = comp()
    let err = ''
    try {
      applyTextEdits(
        before,
        [
          { id: 't1', text: 'fine' },
          { id: 'nope', text: 'x' },
          { id: 't1', colour: '#fff' } as never,
          { id: 'c1', fontFamily: 'comic-sans' },
          { text: 'no window' },
          { id: 'v', text: 'video' },
          { id: 'captions', text: 'lane' },
          { id: 't1', fontSizePx: 5, color: 'red' },
          { id: 't1', text: '   ' },
          { id: 'c1', followLaneStyle: true, color: '#ffffff' },
          { id: 'c1', widthPx: 500 },
          { id: 't1', followLaneStyle: true },
          { id: 't1', kind: 'caption' },
          { text: 'short', startSec: 1, endSec: 1.05 }
        ],
        ctx()
      )
    } catch (e) {
      err = (e as Error).message
    }
    expect(err).toMatch(/^Nothing was changed/)
    expect(err).not.toMatch(/edit 1 /)
    for (const bit of [
      'edit 2 (id "nope"): no text layer or caption',
      'edit 3 (id "t1"): unknown field colour',
      'edit 4 (id "c1"): unknown font "comic-sans"; fonts: ',
      'edit 5 (new): a new item needs startSec and endSec',
      'edit 6 (id "v"): that is a video layer, not text',
      'edit 7 (id "captions"): the caption lane only takes',
      'fontSizePx must be a number from 12 to 1000; color must be a hex colour',
      'edit 9 (id "t1"): text must not be empty',
      'edit 10 (id "c1"): followLaneStyle: true cannot be combined',
      'edit 11 (id "c1"): widthPx is for text layers only',
      'edit 12 (id "t1"): followLaneStyle is for captions only',
      'edit 13 (id "t1"): kind is only for creating',
      'edit 14 (new): endSec must be at least 0.1s after startSec'
    ]) {
      expect(err).toContain(bit)
    }
  })

  it('refuses a timing change on a linked item but allows its text and style', () => {
    const base = comp()
    base.captions = { ...base.captions, segments: [cap({ linkGroupId: 'g' })] }
    base.layers = base.layers.map((l) => (l.id === 'v' ? { ...l, linkGroupId: 'g' } : l))
    expect(() => applyTextEdits(base, [{ id: 'c1', startSec: 3 }], ctx())).toThrow(/linked to another timeline item/)
    expect(() => applyTextEdits(base, [{ id: 'c1', endSec: 4 }], ctx())).not.toThrow() // unchanged window
    const { comp: c } = applyTextEdits(base, [{ id: 'c1', text: 'hello world', color: '#ff0000' }], ctx())
    expect(c.captions.segments[0].text).toBe('hello world')
  })

  it('does not touch the input composition', () => {
    const before = comp()
    const snapshot = JSON.stringify(before)
    applyTextEdits(before, [{ id: 't1', text: 'x', pill: { padPx: 30 } }, { id: 'c1', text: 'a b c' }], ctx())
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
