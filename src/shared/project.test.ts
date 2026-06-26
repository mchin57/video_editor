import { describe, it, expect } from 'vitest'
import { DEFAULT_CAPTION_STYLE, effectiveCaptionStyle, migrateProject } from './project'
import type { CaptionSegment, CaptionsConfig } from './project'
import { DEFAULT_FONT_ID, isKnownFont } from './fonts'

describe('migrateProject — caption style', () => {
  it('seeds a lane-wide caption style from a legacy yBaseline', () => {
    const legacy = {
      version: 5,
      layers: [],
      audioClips: [],
      captions: { enabled: true, stylePreset: 'reels-bold', yBaseline: 1500, segments: [] }
    }
    const p = migrateProject(legacy)
    expect(p.version).toBe(7)
    expect(p.captions.style).toBeDefined()
    expect(p.captions.style.y).toBe(1500) // baseline becomes the style's Y
    expect(p.captions.style.x).toBe(DEFAULT_CAPTION_STYLE.x)
    expect(p.captions.style.color).toBe(DEFAULT_CAPTION_STYLE.color)
  })

  it('normalises legacy CSS-stack font values to a bundled-font id (v7)', () => {
    const legacy = {
      version: 6,
      layers: [
        {
          id: 'l0', hidden: false, startSec: 0, endSec: 2, x: 540, y: 600, scale: 1,
          content: { kind: 'text', text: 'hi', fontFamily: 'Inter, system-ui, sans-serif', fontSizePx: 76, color: '#fff', pill: { enabled: false, color: '#000', padPx: 0 } }
        }
      ],
      audioClips: [],
      captions: {
        enabled: true, stylePreset: 'reels-bold', yBaseline: 1340,
        style: { ...DEFAULT_CAPTION_STYLE, fontFamily: 'Arial, sans-serif' },
        segments: [
          { id: 'c0', startSec: 0, endSec: 1, text: 'x', words: [], enabled: true, style: { ...DEFAULT_CAPTION_STYLE, fontFamily: 'whatever' } }
        ]
      }
    }
    const p = migrateProject(legacy)
    const text = p.layers[0].content
    expect(text.kind).toBe('text')
    if (text.kind === 'text') expect(isKnownFont(text.fontFamily)).toBe(true)
    expect(p.captions.style.fontFamily).toBe(DEFAULT_FONT_ID)
    expect(p.captions.segments[0].style?.fontFamily).toBe(DEFAULT_FONT_ID)
  })

  it('keeps an already-valid bundled-font id', () => {
    const legacy = {
      version: 6, layers: [], audioClips: [],
      captions: {
        enabled: true, stylePreset: 'reels-bold', yBaseline: 1340,
        style: { ...DEFAULT_CAPTION_STYLE, fontFamily: 'anton' }, segments: []
      }
    }
    expect(migrateProject(legacy).captions.style.fontFamily).toBe('anton')
  })

  it('leaves an existing caption style untouched', () => {
    const styled = {
      version: 6,
      layers: [],
      audioClips: [],
      captions: {
        enabled: true,
        stylePreset: 'reels-bold',
        yBaseline: 1340,
        style: { ...DEFAULT_CAPTION_STYLE, color: '#ff0000' },
        segments: []
      }
    }
    expect(migrateProject(styled).captions.style.color).toBe('#ff0000')
  })
})

describe('effectiveCaptionStyle', () => {
  const captions = { style: { ...DEFAULT_CAPTION_STYLE, color: '#ffffff' } } as CaptionsConfig
  const seg = (over: Partial<CaptionSegment> = {}): CaptionSegment => ({
    id: 'c', startSec: 0, endSec: 1, text: 't', words: [], enabled: true, ...over
  })
  it('uses the lane style when a segment has no override', () => {
    expect(effectiveCaptionStyle(captions, seg()).color).toBe('#ffffff')
  })
  it('uses the override when present (exempt from the lane style)', () => {
    const s = seg({ style: { ...DEFAULT_CAPTION_STYLE, color: '#00ff00' } })
    expect(effectiveCaptionStyle(captions, s).color).toBe('#00ff00')
  })
})
