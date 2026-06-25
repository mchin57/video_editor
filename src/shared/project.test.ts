import { describe, it, expect } from 'vitest'
import { DEFAULT_CAPTION_STYLE, effectiveCaptionStyle, migrateProject } from './project'
import type { CaptionSegment, CaptionsConfig } from './project'

describe('migrateProject — caption style', () => {
  it('seeds a lane-wide caption style from a legacy yBaseline', () => {
    const legacy = {
      version: 5,
      layers: [],
      audioClips: [],
      captions: { enabled: true, stylePreset: 'reels-bold', yBaseline: 1500, segments: [] }
    }
    const p = migrateProject(legacy)
    expect(p.version).toBe(6)
    expect(p.captions.style).toBeDefined()
    expect(p.captions.style.y).toBe(1500) // baseline becomes the style's Y
    expect(p.captions.style.x).toBe(DEFAULT_CAPTION_STYLE.x)
    expect(p.captions.style.color).toBe(DEFAULT_CAPTION_STYLE.color)
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
