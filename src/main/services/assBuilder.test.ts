import { describe, it, expect } from 'vitest'
import { buildAss, assColor, type AssOverlay } from './assBuilder'
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from '@shared/project'

const capStyle = (over: Partial<CaptionStyle> = {}): CaptionStyle => ({ ...DEFAULT_CAPTION_STYLE, ...over })

function overlay(over: Partial<AssOverlay> = {}): AssOverlay {
  return {
    text: 'Hook line',
    startSec: 1,
    endSec: 4,
    x: 540,
    y: 600,
    anchor: 'center',
    fontSizePx: 80,
    color: '#ffffff',
    pill: { enabled: true, color: '#000000cc', padPx: 18 },
    ...over
  }
}

const target = { width: 1080, height: 1920 }

describe('assColor', () => {
  it('converts #RRGGBB to opaque ASS BGR', () => {
    expect(assColor('#ffffff')).toBe('&H00FFFFFF')
    expect(assColor('#ff0000')).toBe('&H000000FF') // red → BGR
  })
  it('inverts CSS alpha to ASS alpha', () => {
    expect(assColor('#000000cc')).toBe('&H33000000') // cc(204) → 255-204=51=0x33
  })
})

describe('buildAss', () => {
  it('sets PlayRes to the target (logical space)', () => {
    const s = buildAss([overlay()], target)
    expect(s).toContain('PlayResX: 1080')
    expect(s).toContain('PlayResY: 1920')
  })
  it('emits a Dialogue with timing, position, size and color', () => {
    const s = buildAss([overlay()], target)
    expect(s).toContain('Dialogue: 0,0:00:01.00,0:00:04.00,Pill')
    expect(s).toContain('\\pos(540,600)')
    expect(s).toContain('\\fs80')
    expect(s).toContain('Hook line')
  })
  it('uses the Pill style + box color when pill enabled, Plain otherwise', () => {
    expect(buildAss([overlay({ pill: { enabled: true, color: '#000000cc', padPx: 18 } })], target)).toContain('Pill,,')
    const plain = buildAss([overlay({ pill: { enabled: false, color: '#000000cc', padPx: 18 } })], target)
    expect(plain).toContain('Plain,,')
    expect(plain).not.toContain('\\3c')
  })
  it('skips empty overlays and escapes newlines', () => {
    expect(buildAss([overlay({ text: '   ' })], target)).not.toContain('Dialogue:')
    expect(buildAss([overlay({ text: 'a\nb' })], target)).toContain('a\\Nb')
  })

  it('emits caption events at the baseline when captions are enabled', () => {
    const captions = {
      enabled: true,
      stylePreset: 'reels-bold',
      yBaseline: 1340,
      style: capStyle(),
      segments: [
        { id: 'c0', startSec: 0, endSec: 1, text: 'look at this', words: [], enabled: true },
        { id: 'c1', startSec: 1, endSec: 2, text: 'hidden', words: [], enabled: false }
      ]
    }
    const s = buildAss([], target, captions)
    expect(s).toContain('Style: Caption,')
    expect(s).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Caption,')
    expect(s).toContain('\\pos(540,1340)')
    expect(s).toContain('look at this')
    expect(s).not.toContain('hidden') // disabled segment skipped
  })

  it('omits caption events when captions disabled', () => {
    const captions = {
      enabled: false,
      stylePreset: 'reels-bold',
      yBaseline: 1340,
      style: capStyle(),
      segments: [{ id: 'c0', startSec: 0, endSec: 1, text: 'nope', words: [], enabled: true }]
    }
    expect(buildAss([], target, captions)).not.toContain('Caption,,')
  })

  it('honors a per-caption style override (color, position, rotation, pill)', () => {
    const captions = {
      enabled: true,
      stylePreset: 'reels-bold',
      yBaseline: 1340,
      style: capStyle({ color: '#ffffff' }),
      segments: [
        { id: 'c0', startSec: 0, endSec: 1, text: 'global', words: [], enabled: true },
        {
          id: 'c1',
          startSec: 1,
          endSec: 2,
          text: 'custom',
          words: [],
          enabled: true,
          style: capStyle({ x: 200, y: 400, color: '#ff0000', rotationDeg: 15, pill: { enabled: true, color: '#000000cc', padPx: 20 } })
        }
      ]
    }
    const s = buildAss([], target, captions)
    // Global caption uses the lane style (white, default baseline, Caption style).
    expect(s).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,{\\an5\\pos(540,1340)')
    // Overridden caption: Pill style, moved, red, rotated (ASS uses CCW → -15).
    expect(s).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,Pill,')
    expect(s).toContain('\\pos(200,400)')
    expect(s).toContain(`\\c${assColor('#ff0000')}&`)
    expect(s).toContain('\\frz-15')
    expect(s).toContain('\\bord20')
  })
})
