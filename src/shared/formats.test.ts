import { describe, it, expect } from 'vitest'
import {
  ASPECTS,
  defineAspect,
  definePreset,
  EXPORT_PRESETS,
  INSTAGRAM_SAFE_ZONES,
  isNineSixteen,
  isPresetId,
  presetFor,
  presetGroups,
  SHORT_SIDE
} from './formats'
import { centeredFrame, FULL_FRAME } from './layers'

describe('defineAspect', () => {
  it('derives size, orientation and label from the ratio alone', () => {
    expect(defineAspect(16, 9)).toMatchObject({
      ratioLabel: '16:9',
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      frame: centeredFrame(1920, 1080)
    })
    expect(defineAspect(4, 5)).toMatchObject({ orientation: 'vertical', width: 1080, height: 1350 })
    expect(defineAspect(1, 1)).toMatchObject({ orientation: 'square', width: 1080, height: 1080 })
  })

  it('9:16 is the canonical space, so every existing Reel number is unchanged', () => {
    expect(ASPECTS['9:16']).toMatchObject({ width: 1080, height: 1920, frame: FULL_FRAME })
  })

  it('every built-in aspect: short side 1080, even dims (yuv420), true to its ratio', () => {
    for (const a of Object.values(ASPECTS)) {
      expect(Math.min(a.width, a.height)).toBe(SHORT_SIDE)
      expect(a.width % 2).toBe(0)
      expect(a.height % 2).toBe(0)
      expect(a.width / a.height).toBeCloseTo(a.ratio[0] / a.ratio[1], 2)
      // The frame is the output size, centred on the canonical center.
      expect(a.frame.w).toBe(a.width)
      expect(a.frame.x + a.frame.w / 2).toBe(540)
      expect(a.frame.y + a.frame.h / 2).toBe(960)
    }
  })
})

describe('definePreset (inheritance)', () => {
  it('inherits everything from its aspect and adds a name + extras', () => {
    const p = definePreset('test', 'Test', ASPECTS['21:9'], { hint: 'x', maxDurationSec: 3 })
    expect(p).toMatchObject({ ...ASPECTS['21:9'], id: 'test', name: 'Test (21:9)', hint: 'x', maxDurationSec: 3 })
  })

  it('the Instagram vertical presets share the 9:16 frame and the IG safe zones', () => {
    for (const id of ['reel', 'story', 'carousel'] as const) {
      expect(EXPORT_PRESETS[id].frame).toEqual(FULL_FRAME)
      expect(EXPORT_PRESETS[id].safeZones).toEqual(Object.values(INSTAGRAM_SAFE_ZONES))
    }
    expect(EXPORT_PRESETS.landscape.safeZones).toBeUndefined()
  })

  it('keeps the historical output sizes of the original four presets', () => {
    expect([EXPORT_PRESETS.reel.width, EXPORT_PRESETS.reel.height]).toEqual([1080, 1920])
    expect([EXPORT_PRESETS.square.width, EXPORT_PRESETS.square.height]).toEqual([1080, 1080])
    expect(EXPORT_PRESETS.carousel.maxDurationSec).toBe(5)
  })

  it('preset ids match their record keys (the id is what the project stores)', () => {
    for (const [key, p] of Object.entries(EXPORT_PRESETS)) expect(p.id).toBe(key)
  })
})

describe('lookup', () => {
  it('presetFor falls back to Reel for unknown ids', () => {
    expect(presetFor('landscape').name).toBe('Landscape (16:9)')
    expect(presetFor('nope')).toBe(EXPORT_PRESETS.reel)
    expect(presetFor(undefined)).toBe(EXPORT_PRESETS.reel)
    // Not fooled by Object.prototype keys.
    expect(isPresetId('toString')).toBe(false)
  })

  it('isNineSixteen', () => {
    expect(isNineSixteen(EXPORT_PRESETS.story)).toBe(true)
    expect(isNineSixteen(EXPORT_PRESETS.feed)).toBe(false)
  })

  it('groups every preset exactly once, vertical → square → horizontal', () => {
    const groups = presetGroups()
    expect(groups.map((g) => g.label)).toEqual(['Vertical', 'Square', 'Horizontal'])
    const ids = groups.flatMap((g) => g.presets.map((p) => p.id))
    expect(ids.sort()).toEqual(Object.keys(EXPORT_PRESETS).sort())
    expect(groups[2].presets.map((p) => p.id)).toContain('landscape')
  })
})
