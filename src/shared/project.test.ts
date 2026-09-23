import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CAPTION_STYLE,
  audioClipAudible,
  effectiveCaptionStyle,
  effectiveStabilize,
  migrateProject,
  pillRadiusPx,
  stabilizeOverridden
} from './project'
import type { CaptionSegment, CaptionsConfig, AudioClip } from './project'
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
    expect(p.version).toBe(22)
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
    expect(p.version).toBe(22)
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

describe('migrateProject — comp cells un-mute (v18)', () => {
  /** A layout layer with one comp cell (muted, as pre-v18 conversions left it). */
  const layoutWithCompCell = (mute: boolean): unknown => ({
    id: 'lay',
    hidden: false,
    startSec: 0,
    endSec: 5,
    x: 540,
    y: 960,
    scale: 1,
    content: {
      kind: 'layout',
      presetId: 'split-lr',
      cells: [
        {
          mediaId: null,
          inSec: 0,
          outSec: 5,
          mute,
          rect: { x: 0, y: 0, w: 540, h: 1920 },
          comp: { layers: [], audioClips: [], captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, style: { ...DEFAULT_CAPTION_STYLE }, segments: [] } }
        },
        // A plain clip cell keeps its muted default — that rule is right for a
        // single clip; only compositions mix their own audio.
        { mediaId: 'm', inSec: 0, outSec: 5, mute: true, rect: { x: 540, y: 0, w: 540, h: 1920 } }
      ]
    }
  })

  it('opens the cell gate on a comp cell, leaving plain clip cells muted', () => {
    const p = migrateProject({ version: 17, layers: [layoutWithCompCell(true)], audioClips: [] })
    const cells = (p.layers[0].content as { cells: { mute: boolean }[] }).cells
    expect(cells[0].mute).toBe(false) // the comp panel is audible again
    expect(cells[1].mute).toBe(true) // the clip cell is untouched
    expect(p.version).toBe(22)
  })

  it('reaches comp cells nested inside a compound layer', () => {
    const p = migrateProject({
      version: 17,
      layers: [
        {
          id: 'cmp',
          hidden: false,
          startSec: 0,
          endSec: 5,
          x: 540,
          y: 960,
          scale: 1,
          content: {
            kind: 'compound',
            comp: {
              layers: [layoutWithCompCell(true)],
              audioClips: [],
              captions: { enabled: false, stylePreset: 'reels-bold', yBaseline: 1340, style: { ...DEFAULT_CAPTION_STYLE }, segments: [] }
            }
          }
        }
      ],
      audioClips: []
    })
    const inner = (p.layers[0].content as { comp: { layers: { content: { cells: { mute: boolean }[] } }[] } })
      .comp.layers[0].content.cells
    expect(inner[0].mute).toBe(false)
  })
})

describe('migrateProject — chorus renamed to ensemble (v20)', () => {
  const legacyFxClip = (id: string): Record<string, unknown> => ({
    id,
    mediaId: 'rendered-wet',
    startSec: 1,
    inSec: 0,
    outSec: 0,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    kind: 'fx',
    fx: {
      settings: { kind: 'chorus', chorus: { voices: 3, spreadMs: 32, detuneCents: 14 } },
      fromMediaId: 'src',
      fromInSec: 0,
      fromOutSec: 3
    }
  })

  it('moves a legacy chorus track to ensemble, keeping its settings', () => {
    const p = migrateProject({ version: 19, audioClips: [legacyFxClip('a1')], layers: [] })
    const fx = p.audioClips[0].fx!
    expect(fx.settings.kind).toBe('ensemble')
    // The rendered audio is unchanged, so the numbers that produced it must be.
    expect(fx.settings).toEqual({
      kind: 'ensemble',
      ensemble: { voices: 3, spreadMs: 32, detuneCents: 14 }
    })
    expect('chorus' in fx.settings).toBe(false)
    expect(p.version).toBe(22)
  })

  it('reaches effect tracks inside a nested composition', () => {
    const p = migrateProject({
      version: 19,
      audioClips: [],
      layers: [
        {
          id: 'L1',
          hidden: false,
          startSec: 0,
          endSec: 3,
          x: 540,
          y: 960,
          scale: 1,
          content: {
            kind: 'compound',
            comp: { layers: [], captions: { segments: [] }, audioClips: [legacyFxClip('nested')] }
          }
        }
      ]
    })
    const nested = (p.layers[0].content as { comp: { audioClips: AudioClip[] } }).comp.audioClips[0]
    expect(nested.fx!.settings.kind).toBe('ensemble')
  })

  it('leaves a NEW-style chorus track alone', () => {
    const modern = legacyFxClip('a2')
    ;(modern.fx as { settings: unknown }).settings = {
      kind: 'chorus',
      chorus: { voices: 3, rateHz: 1.2, depth: 0.35 }
    }
    const p = migrateProject({ version: 20, audioClips: [modern], layers: [] })
    expect(p.audioClips[0].fx!.settings).toEqual({
      kind: 'chorus',
      chorus: { voices: 3, rateHz: 1.2, depth: 0.35 }
    })
  })
})

describe('audioClipAudible', () => {
  it('treats an absent mute flag as audible (every pre-v21 clip)', () => {
    expect(audioClipAudible({})).toBe(true)
    expect(audioClipAudible({ mute: undefined })).toBe(true)
  })

  it('is the single decision the preview and the export both act on', () => {
    // They reach silence differently — preview holds gain 0, export drops the
    // clip from the mix — so the DECISION has to come from one place.
    expect(audioClipAudible({ mute: true })).toBe(false)
    expect(audioClipAudible({ mute: false })).toBe(true)
  })
})

describe('migrateProject — per-clip audio mute (v21)', () => {
  it('stamps v21 and leaves older clips audible', () => {
    const p = migrateProject({
      version: 20,
      layers: [],
      audioClips: [
        {
          id: 'a1',
          mediaId: 'm1',
          startSec: 0,
          inSec: 0,
          outSec: 5,
          gainDb: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
          duck: false,
          kind: 'music'
        }
      ]
    })
    expect(p.version).toBe(22)
    expect(p.audioClips[0].mute).toBeUndefined()
    expect(audioClipAudible(p.audioClips[0])).toBe(true)
  })

  it('preserves an explicit mute across a migration', () => {
    const p = migrateProject({
      version: 21,
      layers: [],
      audioClips: [
        {
          id: 'a1',
          mediaId: 'm1',
          startSec: 0,
          inSec: 0,
          outSec: 5,
          gainDb: -6,
          mute: true,
          fadeInSec: 0,
          fadeOutSec: 0,
          duck: false,
          kind: 'music'
        }
      ]
    })
    // The level survives muting — that is the point of a separate flag.
    expect(p.audioClips[0].mute).toBe(true)
    expect(p.audioClips[0].gainDb).toBe(-6)
  })
})

describe('migrateProject v22 (format registry)', () => {
  it('keeps every known preset id, old and new', () => {
    for (const preset of ['reel', 'story', 'square', 'carousel', 'landscape', 'feed']) {
      expect(migrateProject({ version: 21, preset, layers: [], audioClips: [] }).preset).toBe(preset)
    }
  })

  it('normalises an unknown or missing preset to the default instead of crashing lookups', () => {
    expect(migrateProject({ version: 21, preset: 'imax-70mm', layers: [], audioClips: [] }).preset).toBe('reel')
    expect(migrateProject({ version: 21, layers: [], audioClips: [] }).preset).toBe('reel')
  })

  it('moves no layer when the format is part of the document', () => {
    const layer = { id: 'v', hidden: false, startSec: 0, endSec: 2, x: 123, y: 456, scale: 0.7, content: { kind: 'text', text: 'hi' } }
    const p = migrateProject({ version: 21, preset: 'square', layers: [layer], audioClips: [] })
    expect(p.layers[0]).toMatchObject({ x: 123, y: 456, scale: 0.7 })
    expect(p.version).toBe(22)
  })
})
