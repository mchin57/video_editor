import { describe, it, expect } from 'vitest'
import { buildChecklist } from './checklist'
import { createEmptyProject, type CaptionSegment, type Layer, type Project } from '@shared/project'

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

const baseInput = { durationSec: 45, keywordBank: ['triathlon training'], is916: true }
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

  it('produces a 0–100 score', () => {
    const r = buildChecklist(createEmptyProject('p', 'P'), baseInput)
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
})
