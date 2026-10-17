import { describe, expect, it } from 'vitest'
import type { TextStyleBase } from './project'
import { pickTextStyle, sanitizeTextStyles, upsertTextStyle, type TextStylePreset } from './textStylePresets'

const base: TextStyleBase = {
  fontFamily: 'anton',
  fontSizePx: 110,
  color: '#FFE600',
  pill: { enabled: true, color: '#000000cc', padPx: 18 }
}

describe('pickTextStyle', () => {
  it('keeps only the style fields and turns absent decorations into null (so applying removes them)', () => {
    const layerContent = { ...base, kind: 'text', text: 'SWIM', widthPx: 500, stroke: { widthPx: 6, color: '#000' } }
    expect(pickTextStyle(layerContent)).toEqual({ ...base, stroke: { widthPx: 6, color: '#000' }, shadow: null, gradient: null })
  })
  it('copies nested objects (a later edit to the source cannot change the preset)', () => {
    const src = { ...base, pill: { ...base.pill } }
    const picked = pickTextStyle(src)
    src.pill.padPx = 99
    expect(picked.pill.padPx).toBe(18)
  })
})

describe('upsertTextStyle', () => {
  it('appends a new name and replaces an existing one in place (case-insensitive), keeping its id', () => {
    let list: TextStylePreset[] = []
    list = upsertTextStyle(list, 'Hook', base, undefined, 'a')
    list = upsertTextStyle(list, 'Caption', { ...base, fontSizePx: 60 }, undefined, 'b')
    list = upsertTextStyle(list, ' hook ', { ...base, color: '#FFFFFF' }, { in: 'bounce', inSec: 0.4, out: 'none', outSec: 0.3 }, 'c')
    expect(list.map((p) => [p.id, p.name])).toEqual([['a', 'hook'], ['b', 'Caption']])
    expect(list[0].style.color).toBe('#FFFFFF')
    expect(list[0].animation?.in).toBe('bounce')
  })
  it('refuses a blank name and caps a long one', () => {
    expect(upsertTextStyle([], '   ', base, undefined, 'a')).toEqual([])
    expect(upsertTextStyle([], 'x'.repeat(100), base, undefined, 'a')[0].name).toHaveLength(40)
  })
})

describe('sanitizeTextStyles', () => {
  it('keeps well-formed presets and drops anything else', () => {
    const good = { id: 'a', name: 'Hook', style: base }
    expect(sanitizeTextStyles([good, { id: 'b', name: 'half', style: { fontFamily: 'anton' } }, null, 'x', { id: 'c', name: '', style: base }])).toEqual([good])
    expect(sanitizeTextStyles(undefined)).toEqual([])
    expect(sanitizeTextStyles({})).toEqual([])
  })
})
