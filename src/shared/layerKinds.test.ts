import { describe, expect, it } from 'vitest'
import { assertNever, kindInfo, LAYER_KINDS, layerMediaId } from './layerKinds'
import { layerLabel, makeTextLayer } from './layers'
import { createEmptyComposition, type Layer, type LayerContent } from './project'

const layer = (content: LayerContent, name?: string): Layer => ({
  id: 'L',
  hidden: false,
  startSec: 0,
  endSec: 1,
  x: 540,
  y: 960,
  scale: 1,
  content,
  ...(name ? { name } : {})
})
const compound = (): LayerContent => ({ kind: 'compound', comp: createEmptyComposition() })

describe('LAYER_KINDS', () => {
  it('names a compound layer as a compound clip, not text (#98)', () => {
    const c = kindInfo(layer(compound()))
    expect(c.title).toBe('Compound clip')
    expect(c.icon).toBe('🧩')
    expect(c.icon).not.toBe(LAYER_KINDS.text.icon)
  })

  it('every kind has its own title and icon', () => {
    const entries = Object.values(LAYER_KINDS)
    expect(new Set(entries.map((k) => k.title)).size).toBe(entries.length)
    expect(new Set(entries.map((k) => k.icon)).size).toBe(entries.length)
  })

  it('keeps the capabilities the editor already had', () => {
    // Rotation and straight-line motion: video, image, text.
    const rotatable = Object.entries(LAYER_KINDS)
      .filter(([, k]) => k.rotatable)
      .map(([id]) => id)
    expect(rotatable).toEqual(['video', 'image', 'text'])
    const motion = Object.entries(LAYER_KINDS)
      .filter(([, k]) => k.motion)
      .map(([id]) => id)
    expect(motion).toEqual(['video', 'image', 'text'])
    // Keyframes: media transform, text path, the comp kinds none (the export has no path for them).
    expect(LAYER_KINDS.video.keyframes).toBe('transform')
    expect(LAYER_KINDS.image.keyframes).toBe('transform')
    expect(LAYER_KINDS.text.keyframes).toBe('path')
    expect(LAYER_KINDS.layout.keyframes).toBe('none')
    expect(LAYER_KINDS.compound.keyframes).toBe('none')
  })
})

describe('layerMediaId', () => {
  it('is the clip of a video or image layer, null otherwise', () => {
    expect(layerMediaId({ kind: 'image', mediaId: 'm1' } as LayerContent)).toBe('m1')
    expect(layerMediaId({ kind: 'video', mediaId: 'm2' } as LayerContent)).toBe('m2')
    expect(layerMediaId(makeTextLayer('T', 0, 1).content)).toBeNull()
    expect(layerMediaId(compound())).toBeNull()
  })
})

describe('layerLabel', () => {
  it('uses the custom name, then a text layer’s text, then the kind name', () => {
    expect(layerLabel(layer(compound(), 'Intro'))).toBe('Intro')
    expect(layerLabel(layer(compound()))).toBe('Compound clip')
    const text = makeTextLayer('T', 0, 1)
    expect(layerLabel({ ...text, content: { ...text.content, text: '  Hook ' } } as Layer)).toBe('Hook')
    expect(layerLabel({ ...text, content: { ...text.content, text: '  ' } } as Layer)).toBe('Text')
  })
})

describe('assertNever', () => {
  it('throws on a value that should be impossible', () => {
    expect(() => assertNever('nope' as never, 'layer kind')).toThrow('Unexpected layer kind: "nope"')
  })
})
