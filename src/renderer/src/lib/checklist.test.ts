import { describe, it, expect } from 'vitest'
import { buildChecklist } from './checklist'
import { createEmptyProject, type CaptionSegment, type Layer, type Project } from '@shared/project'
import { EXPORT_PRESETS } from '@shared/formats'

function textLayer(over: { startSec?: number; endSec?: number; y?: number; text?: string } = {}): Layer {
  return {
    id: 'o',
    hidden: false,
    startSec: over.startSec ?? 0,
    endSec: over.endSec ?? 3,
    x: 540,
    y: over.y ?? 600,
    scale: 1,
    content: {
      kind: 'text',
      text: over.text ?? 'Hook',
      fontFamily: 'Inter',
      fontSizePx: 76,
      color: '#fff',
      pill: { enabled: true, color: '#000c', padPx: 18 }
    }
  }
}
function caption(text: string, startSec = 0, endSec = 2): CaptionSegment {
  return { id: 'c', startSec, endSec, text, words: [], enabled: true }
}

const baseInput = { durationSec: 45, keywordBank: ['triathlon training'], format: EXPORT_PRESETS.reel }
const statusOf = (r: ReturnType<typeof buildChecklist>, id: string): string =>
  r.items.find((i) => i.id === id)!.status

describe('buildChecklist', () => {
  it('fails the hook check with no early text, passes with it', () => {
    const empty = createEmptyProject('p', 'P')
    expect(statusOf(buildChecklist(empty, baseInput), 'hook')).toBe('fail')

    const withHook: Project = { ...empty, layers: [textLayer({ startSec: 0, endSec: 3 })] }
    expect(statusOf(buildChecklist(withHook, baseInput), 'hook')).toBe('pass')
  })

  it('scores length: pass in range, warn short, fail way off', () => {
    const p = createEmptyProject('p', 'P')
    expect(statusOf(buildChecklist(p, { ...baseInput, durationSec: 45 }), 'length')).toBe('pass')
    expect(statusOf(buildChecklist(p, { ...baseInput, durationSec: 10 }), 'length')).toBe('warn')
    expect(statusOf(buildChecklist(p, { ...baseInput, durationSec: 300 }), 'length')).toBe('fail')
  })

  it('detects spoken keywords from captions', () => {
    const base = createEmptyProject('p', 'P')
    const p: Project = {
      ...base,
      captions: { ...base.captions, enabled: true, segments: [caption('todays triathlon training session')] }
    }
    const r = buildChecklist(p, { ...baseInput, keywordBank: ['triathlon training', 'open water'] })
    expect(statusOf(r, 'keywords')).toBe('pass')
    expect(statusOf(r, 'captions')).toBe('pass')
  })

  it('warns on keywords when captions exist but none match', () => {
    const base = createEmptyProject('p', 'P')
    const p: Project = {
      ...base,
      captions: { ...base.captions, enabled: true, segments: [caption('hello world')] }
    }
    expect(statusOf(buildChecklist(p, baseInput), 'keywords')).toBe('warn')
  })

  it('flags text layers intruding the bottom safe zone', () => {
    const p: Project = { ...createEmptyProject('p', 'P'), layers: [textLayer({ y: 1700 })] }
    expect(statusOf(buildChecklist(p, baseInput), 'safezones')).toBe('warn')
  })

  it('checks safe zones in FRAME space, and only for formats that have them', () => {
    const p: Project = { ...createEmptyProject('p', 'P'), layers: [textLayer({ y: 1700 })] }
    // Landscape carries no platform UI — nothing to sit behind.
    expect(statusOf(buildChecklist(p, { ...baseInput, format: EXPORT_PRESETS.landscape }), 'safezones')).toBe('pass')
    // A format WITH zones in a shifted frame: a zone at frame-y 1440 sits at
    // canonical y 1440 + frame.y, so text at canonical 1700 must clear it.
    const shifted = { ...EXPORT_PRESETS.square, safeZones: [{ x: 0, y: 900, w: 1080, h: 180 }] }
    expect(statusOf(buildChecklist(p, { ...baseInput, format: shifted }), 'safezones')).toBe('pass') // 1700−420=1280 > 1080
    const low = { ...p, layers: [textLayer({ y: 1400 })] } // 1400−420 = 980, inside 900..1080
    expect(statusOf(buildChecklist(low, { ...baseInput, format: shifted }), 'safezones')).toBe('warn')
  })

  it('scores the aspect from the format', () => {
    const p = createEmptyProject('p', 'P')
    expect(statusOf(buildChecklist(p, baseInput), 'aspect')).toBe('pass')
    expect(statusOf(buildChecklist(p, { ...baseInput, format: EXPORT_PRESETS.square }), 'aspect')).toBe('warn')
  })

  it('produces a 0–100 score', () => {
    const r = buildChecklist(createEmptyProject('p', 'P'), baseInput)
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
})
