import { describe, it, expect } from 'vitest'
import {
  PROJECT_VERSION,
  DEFAULT_CAPTION_STYLE,
  audioClipAudible,
  createEmptyProject,
  effectiveCaptionStyle,
  effectiveStabilize,
  mediaUses,
  migrateProject,
  pillRadiusPx,
  stabilizeOverridden
} from './project'
import type { CaptionSegment, CaptionsConfig, AudioClip, Layer } from './project'
import { DEFAULT_FONT_ID, isKnownFont } from './fonts'
import { makeWorkoutLayer } from './layers'

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
    expect(p.version).toBe(PROJECT_VERSION)
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
          id: 'l0',
          hidden: false,
          startSec: 0,
          endSec: 2,
          x: 540,
          y: 600,
          scale: 1,
          content: {
            kind: 'text',
            text: 'hi',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSizePx: 76,
            color: '#fff',
            pill: { enabled: false, color: '#000', padPx: 0 }
          }
        }
      ],
      audioClips: [],
      captions: {
        enabled: true,
        stylePreset: 'reels-bold',
        yBaseline: 1340,
        style: { ...DEFAULT_CAPTION_STYLE, fontFamily: 'Arial, sans-serif' },
        segments: [
          {
            id: 'c0',
            startSec: 0,
            endSec: 1,
            text: 'x',
            words: [],
            enabled: true,
            style: { ...DEFAULT_CAPTION_STYLE, fontFamily: 'whatever' }
          }
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
      version: 6,
      layers: [],
      audioClips: [],
      captions: {
        enabled: true,
        stylePreset: 'reels-bold',
        yBaseline: 1340,
        style: { ...DEFAULT_CAPTION_STYLE, fontFamily: 'anton' },
        segments: []
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
    id: 'a',
    mediaId: 'm',
    startSec: 0,
    inSec: 0,
    outSec: 0,
    gainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duck: false,
    kind: 'music',
    ...over
  })

  it('defaults denoiseDefault to false and normalises legacy denoise:false to inherit', () => {
    const legacy = {
      version: 7,
      layers: [],
      captions: { style: DEFAULT_CAPTION_STYLE, segments: [] },
      audioClips: [clip({ denoise: false })]
    }
    const p = migrateProject(legacy)
    expect(p.denoiseDefault).toBe(false)
    expect(p.audioClips[0].denoise).toBeUndefined() // redundant explicit-off → inherit
    expect(p.version).toBe(PROJECT_VERSION)
  })

  it('keeps an explicit denoise:true override across migration', () => {
    const legacy = {
      version: 7,
      layers: [],
      captions: { style: DEFAULT_CAPTION_STYLE, segments: [] },
      audioClips: [clip({ denoise: true })]
    }
    expect(migrateProject(legacy).audioClips[0].denoise).toBe(true)
  })

  it('does not re-normalise denoise:false once already at v8 (an intentional force-off)', () => {
    const current = {
      version: 8,
      denoiseDefault: true,
      layers: [],
      captions: { style: DEFAULT_CAPTION_STYLE, segments: [] },
      audioClips: [clip({ denoise: false })]
    }
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
    id: 'c',
    startSec: 0,
    endSec: 1,
    text: 't',
    words: [],
    enabled: true,
    ...over
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
          comp: {
            layers: [],
            audioClips: [],
            captions: {
              enabled: false,
              stylePreset: 'reels-bold',
              yBaseline: 1340,
              style: { ...DEFAULT_CAPTION_STYLE },
              segments: []
            }
          }
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
    expect(p.version).toBe(PROJECT_VERSION)
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
              captions: {
                enabled: false,
                stylePreset: 'reels-bold',
                yBaseline: 1340,
                style: { ...DEFAULT_CAPTION_STYLE },
                segments: []
              }
            }
          }
        }
      ],
      audioClips: []
    })
    const inner = (p.layers[0].content as { comp: { layers: { content: { cells: { mute: boolean }[] } }[] } }).comp
      .layers[0].content.cells
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
    expect(p.version).toBe(PROJECT_VERSION)
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
    expect(p.version).toBe(PROJECT_VERSION)
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
    const layer = {
      id: 'v',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 123,
      y: 456,
      scale: 0.7,
      content: { kind: 'text', text: 'hi' }
    }
    const p = migrateProject({ version: 21, preset: 'square', layers: [layer], audioClips: [] })
    expect(p.layers[0]).toMatchObject({ x: 123, y: 456, scale: 0.7 })
    expect(p.version).toBe(PROJECT_VERSION)
  })
})

describe('migrateProject v23 (layer rotation + video flips)', () => {
  it('is additive: an older layer comes back upright and unflipped, untouched', () => {
    const layer = {
      id: 'v',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 10,
      y: 20,
      scale: 1,
      content: { kind: 'video', mediaId: 'm', inSec: 0, outSec: 2, mute: false, gainDb: 0 }
    }
    const p = migrateProject({ version: 22, preset: 'reel', layers: [layer], audioClips: [] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.layers[0].rotationDeg).toBeUndefined()
    expect(p.layers[0]).toMatchObject({ x: 10, y: 20, scale: 1 })
  })
  it('keeps a saved rotation', () => {
    const layer = {
      id: 't',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 0,
      y: 0,
      scale: 1,
      rotationDeg: -30,
      content: { kind: 'text', text: 'hi' }
    }
    expect(migrateProject({ version: 23, preset: 'reel', layers: [layer], audioClips: [] }).layers[0].rotationDeg).toBe(
      -30
    )
  })
})

describe('migrateProject — graphics layers (v27)', () => {
  it('stamps a v26 document as v27 and keeps a graphics layer (with its marks) as saved', () => {
    const marks = [
      {
        id: 'm',
        tool: 'angle',
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 }
        ],
        color: '#ffd60a',
        widthPx: 8,
        atSec: 0.5,
        entrance: { kind: 'drawOn', sec: 0.4 }
      }
    ]
    const graphics = {
      id: 'G',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'graphics', marks }
    }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 26, layers: [graphics] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.layers[0]).toEqual(graphics)
  })
})

describe('migrateProject — connected lines and teardrops (v33)', () => {
  it('stamps a v32 document current; connected-line and teardrop marks load as saved', () => {
    const mark = { color: '#ffd60a', widthPx: 8, atSec: 0, entrance: { kind: 'instant', sec: 0.4 } }
    const marks = [
      {
        ...mark,
        id: 'line',
        tool: 'polyline',
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
          { x: 7, y: 8 }
        ]
      },
      {
        ...mark,
        id: 'drop',
        tool: 'teardrop',
        points: [
          { x: 10, y: 20 },
          { x: 10, y: 80 }
        ],
        fill: '#3388ff80',
        dropWidth: 0.8
      }
    ]
    const graphics = {
      id: 'G',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'graphics', marks }
    }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 32, layers: [graphics] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(PROJECT_VERSION).toBeGreaterThanOrEqual(33)
    expect(p.layers[0]).toEqual(graphics)
  })
})

describe('migrateProject — per-mark animation (v34)', () => {
  it('stamps a v33 document current; mark keyframes, pivot and static pose load as saved, and an old mark has none', () => {
    const base = { color: '#ffd60a', widthPx: 8, atSec: 0, entrance: { kind: 'instant', sec: 0.4 } }
    const pts = [
      { x: 1, y: 2 },
      { x: 30, y: 40 }
    ]
    const marks = [
      { ...base, id: 'old', tool: 'rect', points: pts },
      {
        ...base,
        id: 'anim',
        tool: 'rect',
        points: pts,
        pivot: { x: 5, y: 6 },
        rotationDeg: 15,
        scale: 1.5,
        opacity: 0.5,
        keyframes: [
          {
            tSec: 0,
            dx: 0,
            dy: 0,
            scale: 1,
            rotationDeg: 0,
            opacity: 1,
            drawn: 1,
            color: '#fff',
            widthPx: 8,
            easing: 'linear'
          },
          {
            tSec: 1,
            dx: 90,
            dy: 0,
            scale: 1,
            rotationDeg: 90,
            opacity: 1,
            drawn: 1,
            color: '#000',
            widthPx: 8,
            easing: 'easeIn'
          }
        ]
      }
    ]
    const graphics = {
      id: 'G',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'graphics', marks }
    }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 33, layers: [graphics] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(PROJECT_VERSION).toBeGreaterThanOrEqual(34)
    expect(p.layers[0]).toEqual(graphics)
  })
})

describe('migrateProject — pose overlay (v28)', () => {
  it('stamps a v27 document current; a clip’s pose settings load as saved, and an old clip has none', () => {
    const pose = { show: true, people: [{ tracks: [1, 3], color: '#FFD60A' }], angles: ['leftKnee'], widthPx: 6 }
    const withPose = {
      id: 'V',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'video', mediaId: 'm', inSec: 0, outSec: 2, mute: false, gainDb: 0, pose }
    }
    const old = { ...withPose, id: 'O', content: { ...withPose.content, pose: undefined } }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 27, layers: [withPose, old] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.layers[0]).toEqual(withPose)
    expect((p.layers[1].content as { pose?: unknown }).pose).toBeUndefined()
  })
})

describe('migrateProject — clip tint (v29)', () => {
  it('stamps a v28 document as current; a tint loads as saved, and an old clip has none', () => {
    const tint = { color: '#e8c290', amount: 0.6 }
    const tinted = {
      id: 'V',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'video', mediaId: 'm', inSec: 0, outSec: 2, mute: false, gainDb: 0, tint }
    }
    const old = { ...tinted, id: 'O', content: { ...tinted.content, tint: undefined } }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 28, layers: [tinted, old] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.layers[0]).toEqual(tinted)
    expect((p.layers[1].content as { tint?: unknown }).tint).toBeUndefined()
  })
})

describe('migrateProject — workout overlays (v30)', () => {
  it('stamps a v29 document as current; a workout layer loads as saved', () => {
    const w = makeWorkoutLayer('W', 'fit', 2, { inSec: 30, outSec: 830, speed: 100 }, [
      { id: 'p', metric: 'power', x: 190, y: 1440, sizePx: 96, color: '#FFFFFF' }
    ])
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 29, layers: [w] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.layers[0]).toEqual(w)
    expect(mediaUses(p)).toEqual([{ mediaId: 'fit', as: 'workout', outSec: 830 }])
  })
})

describe('migrateProject — audio volume lines (v31)', () => {
  it('stamps a v30 document as current; clips with and without a line load as saved', () => {
    const flat = {
      id: 'A',
      mediaId: 'm',
      startSec: 0,
      inSec: 0,
      outSec: 4,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'music' as const
    }
    const lined = {
      ...flat,
      id: 'B',
      volumeKeyframes: [
        { sourceSec: 1, db: 0 },
        { sourceSec: 2, db: -12 }
      ]
    }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 30, audioClips: [flat, lined] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(p.audioClips[0]).toEqual(flat)
    expect(p.audioClips[0].volumeKeyframes).toBeUndefined()
    expect(p.audioClips[1]).toEqual(lined)
  })
})

describe('migrateProject — audio re-timing (v32)', () => {
  it('stamps a v31 document as v32; clips with and without speed or holds load as saved', () => {
    expect(PROJECT_VERSION).toBeGreaterThanOrEqual(32)
    const plain = {
      id: 'A',
      mediaId: 'm',
      startSec: 0,
      inSec: 0,
      outSec: 4,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      duck: false,
      kind: 'extracted' as const
    }
    const retimed = { ...plain, id: 'B', speed: 0.5, freezes: [{ atSec: 1, holdSec: 2 }] }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 31, audioClips: [plain, retimed] })
    expect(p.version).toBe(PROJECT_VERSION)
    // Absent = 1x with no holds: nothing is written onto an old clip.
    expect(p.audioClips[0]).toEqual(plain)
    expect('speed' in p.audioClips[0]).toBe(false)
    expect('freezes' in p.audioClips[0]).toBe(false)
    expect(p.audioClips[1]).toEqual(retimed)
  })
})

describe('migrateProject — transitions (v35)', () => {
  it('stamps a v34 document current; layers with and without transitions load as saved', () => {
    expect(PROJECT_VERSION).toBeGreaterThanOrEqual(35)
    const plain: Layer = {
      id: 'v',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'image', mediaId: 'm', opacity: 1 }
    }
    const faded: Layer = {
      ...plain,
      id: 'w',
      transitionIn: { kind: 'dissolve', sec: 0.5 },
      transitionOut: { kind: 'fade', sec: 1 }
    }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 34, layers: [plain, faded] })
    expect(p.version).toBe(PROJECT_VERSION)
    // Absent = a cut: nothing is written onto an old layer.
    expect(p.layers[0]).toEqual(plain)
    expect('transitionIn' in p.layers[0]).toBe(false)
    expect('transitionOut' in p.layers[0]).toBe(false)
    expect(p.layers[1]).toEqual(faded)
  })
})

describe('migrateProject — colour table controls and LUTs (v36)', () => {
  it('stamps an older document current; graded clips and images load as saved, nothing is added', () => {
    expect(PROJECT_VERSION).toBeGreaterThanOrEqual(36)
    const base = { hidden: false, startSec: 0, endSec: 2, x: 540, y: 960, scale: 1 }
    const graded = {
      ...base,
      id: 'V',
      content: {
        kind: 'video',
        mediaId: 'm',
        inSec: 0,
        outSec: 2,
        mute: false,
        gainDb: 0,
        color: { brightness: 0.2, contrast: 1.3, saturation: 1.4 },
        tint: { color: '#e8c290', amount: 0.6 }
      }
    }
    const image = { ...base, id: 'I', content: { kind: 'image', mediaId: 'i', opacity: 1 } }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 35, layers: [graded, image] })
    expect(p.version).toBe(PROJECT_VERSION)
    // Absent = neutral: an old grade keeps exactly its fields (so its CSS / lutrgb look).
    expect(p.layers[0]).toEqual(graded)
    expect(p.layers[1]).toEqual(image)
    for (const k of ['lut', 'color', 'tint']) expect(k in p.layers[1].content).toBe(false)
    expect('lut' in p.layers[0].content).toBe(false)
  })

  it('a document using the new fields loads them as saved', () => {
    const look = {
      color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0.4, greenMagenta: -0.2, vibrance: 0.3 },
      lut: { file: '0123456789ab.cube', name: 'Warm', strength: 0.6 }
    }
    const l = {
      id: 'I',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 960,
      scale: 1,
      content: { kind: 'image', mediaId: 'i', opacity: 1, ...look }
    }
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: PROJECT_VERSION, layers: [l] })
    expect(p.layers[0]).toEqual(l)
  })
})

describe('migrateProject — mark entrance presets (v37)', () => {
  const mk = (id: string, reveal: string) => ({
    id,
    tool: 'line',
    points: [
      { x: 1, y: 2 },
      { x: 3, y: 4 }
    ],
    color: '#ffd60a',
    widthPx: 8,
    atSec: 0,
    reveal
  })
  const layer = (id: string, content: unknown) => ({
    id,
    hidden: false,
    startSec: 0,
    endSec: 3,
    x: 540,
    y: 960,
    scale: 1,
    content
  })

  it('turns every reveal (root and inside a compound clip) into a 0.4 s entrance', () => {
    const inner = layer('GI', { kind: 'graphics', marks: [mk('c', 'draw')] })
    const compound = layer('C', {
      kind: 'compound',
      comp: { layers: [inner], audioClips: [], captions: { enabled: false, segments: [] } }
    })
    const root = layer('G', { kind: 'graphics', marks: [mk('a', 'pop'), mk('b', 'fade')] })
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 36, layers: [root, compound] })
    expect(p.version).toBe(PROJECT_VERSION)
    const marks = (p.layers[0].content as unknown as { marks: Record<string, unknown>[] }).marks
    expect(marks.map((m) => m.entrance)).toEqual([
      { kind: 'instant', sec: 0.4 },
      { kind: 'fadeIn', sec: 0.4 }
    ])
    expect(marks.every((m) => !('reveal' in m))).toBe(true)
    const comp = (
      p.layers[1].content as unknown as { comp: { layers: { content: { marks: Record<string, unknown>[] } }[] } }
    ).comp
    expect(comp.layers[0].content.marks[0]).toMatchObject({ entrance: { kind: 'drawOn', sec: 0.4 } })
    expect('reveal' in comp.layers[0].content.marks[0]).toBe(false)
  })

  it('also converts the marks of a comp inside a layout cell', () => {
    const inner = layer('GI', { kind: 'graphics', marks: [mk('a', 'draw'), mk('b', 'pop')] })
    const cell = (comp: unknown) => ({
      mediaId: null,
      inSec: 0,
      outSec: 3,
      mute: false,
      rect: { x: 0, y: 0, w: 540, h: 960 },
      comp
    })
    const lay = layer('L', {
      kind: 'layout',
      presetId: 'split-v',
      cells: [cell({ layers: [inner], audioClips: [], captions: { enabled: false, segments: [] } }), cell(null)]
    })
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 36, layers: [lay] })
    const cells = (p.layers[0].content as unknown as { cells: { comp: unknown }[] }).cells
    const marks = (cells[0].comp as { layers: { content: { marks: Record<string, unknown>[] } }[] }).layers[0].content
      .marks
    expect(marks.map((m) => m.entrance)).toEqual([
      { kind: 'drawOn', sec: 0.4 },
      { kind: 'instant', sec: 0.4 }
    ])
    expect(marks.every((m) => !('reveal' in m))).toBe(true)
    expect(cells[1].comp).toBeNull()
  })

  it('leaves a v37 document untouched', () => {
    const { reveal: _r, ...base } = mk('a', 'x')
    void _r
    const marks = [{ ...base, entrance: { kind: 'popIn', sec: 0.7 }, exit: { kind: 'fadeOut', sec: 0.3 } }]
    const g = layer('G', { kind: 'graphics', marks })
    const p = migrateProject({ ...createEmptyProject('p', 'P'), layers: [g] })
    expect(p.layers[0]).toEqual(g)
  })

  it('v38: leaves a v37 mark without sparkles untouched and keeps one that has them', () => {
    const { reveal: _r, ...base } = mk('a', 'x')
    void _r
    const plain = { ...base, entrance: { kind: 'instant', sec: 0.4 } }
    const sparked = { ...plain, id: 'b', sparkle: { density: 6, color: '#ffffff' } }
    const g = layer('G', { kind: 'graphics', marks: [plain, sparked] })
    const p = migrateProject({ ...createEmptyProject('p', 'P'), version: 37, layers: [g] })
    expect(p.version).toBe(PROJECT_VERSION)
    expect(PROJECT_VERSION).toBe(38)
    expect(p.layers[0]).toEqual(g)
    const marks = (p.layers[0].content as unknown as { marks: Record<string, unknown>[] }).marks
    expect('sparkle' in marks[0]).toBe(false)
    expect(marks[1].sparkle).toEqual({ density: 6, color: '#ffffff' })
  })
})
