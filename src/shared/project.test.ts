import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CAPTION_STYLE,
  effectiveCaptionStyle,
  effectiveStabilize,
  migrateProject,
  pillRadiusPx,
  stabilizeOverridden
} from './project'
import type { CaptionSegment, CaptionsConfig } from './project'
import { DEFAULT_FONT_ID, isKnownFont } from './fonts'

describe('pillRadiusPx', () => {
  it('scales the corner radius with padding (0.6×, rounded)', () => {
    expect(pillRadiusPx(0)).toBe(0)
    expect(pillRadiusPx(10)).toBe(6)
    expect(pillRadiusPx(18)).toBe(11) // default caption/overlay padding
    expect(pillRadiusPx(25)).toBe(15)
  })
})

describe('migrateProject — caption style', () => {
  it('seeds a lane-wide caption style from a legacy yBaseline', () => {
    const legacy = {
      version: 5,
      layers: [],
      audioClips: [],
      captions: { enabled: true, stylePreset: 'reels-bold', yBaseline: 1500, segments: [] }
    }
    const p = migrateProject(legacy)
    expect(p.version).toBe(12)
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

describe('migrateProject — noise filter default (v8)', () => {
  const clip = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'a', mediaId: 'm', startSec: 0, inSec: 0, outSec: 0,
    gainDb: 0, fadeInSec: 0, fadeOutSec: 0, duck: false, kind: 'music', ...over
  })

  it('defaults denoiseDefault to false and normalises legacy denoise:false to inherit', () => {
    const legacy = { version: 7, layers: [], captions: { style: DEFAULT_CAPTION_STYLE, segments: [] }, audioClips: [clip({ denoise: false })] }
    const p = migrateProject(legacy)
    expect(p.denoiseDefault).toBe(false)
    expect(p.audioClips[0].denoise).toBeUndefined() // redundant explicit-off → inherit
    expect(p.version).toBe(12)
  })

  it('keeps an explicit denoise:true override across migration', () => {
    const legacy = { version: 7, layers: [], captions: { style: DEFAULT_CAPTION_STYLE, segments: [] }, audioClips: [clip({ denoise: true })] }
    expect(migrateProject(legacy).audioClips[0].denoise).toBe(true)
  })

  it('does not re-normalise denoise:false once already at v8 (an intentional force-off)', () => {
    const current = { version: 8, denoiseDefault: true, layers: [], captions: { style: DEFAULT_CAPTION_STYLE, segments: [] }, audioClips: [clip({ denoise: false })] }
    const p = migrateProject(current)
    expect(p.denoiseDefault).toBe(true)
    expect(p.audioClips[0].denoise).toBe(false) // stays a real override
  })
})

describe('stabilization default + per-clip override', () => {
  it('defaults stabilizeDefault to null (off) on migration', () => {
    const legacy = { version: 7, layers: [], captions: { style: DEFAULT_CAPTION_STYLE, segments: [] }, audioClips: [] }
    expect(migrateProject(legacy).stabilizeDefault).toBeNull()
  })

  it('effectiveStabilize: clip override wins, else the project default', () => {
    const def = { shakiness: 5, smoothing: 15 }
    const clipOn = { shakiness: 3, smoothing: 30 }
    expect(effectiveStabilize({ stabilize: undefined }, def)).toBe(def) // inherit on
    expect(effectiveStabilize({}, def)).toBe(def) // absent = inherit
    expect(effectiveStabilize({ stabilize: undefined }, null)).toBeNull() // inherit off
    expect(effectiveStabilize({ stabilize: null }, def)).toBeNull() // force off
    expect(effectiveStabilize({ stabilize: clipOn }, null)).toBe(clipOn) // force on
  })

  it('stabilizeOverridden: only explicit on/off flag an indicator', () => {
    expect(stabilizeOverridden({ stabilize: undefined })).toBe(false)
    expect(stabilizeOverridden({})).toBe(false)
    expect(stabilizeOverridden({ stabilize: null })).toBe(true)
    expect(stabilizeOverridden({ stabilize: { shakiness: 5, smoothing: 15 } })).toBe(true)
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
