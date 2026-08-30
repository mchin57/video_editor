import { describe, it, expect } from 'vitest'
import { buildAss, assColor, type AssOverlay } from './assBuilder'
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from '@shared/project'
import { DEFAULT_FONT_ID, resolveFont } from '@shared/fonts'

const capStyle = (over: Partial<CaptionStyle> = {}): CaptionStyle => ({ ...DEFAULT_CAPTION_STYLE, ...over })

function overlay(over: Partial<AssOverlay> = {}): AssOverlay {
  return {
    text: 'Hook line',
    startSec: 1,
    endSec: 4,
    x: 540,
    y: 600,
    anchor: 'center',
    fontFamily: DEFAULT_FONT_ID,
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
  it('expands shorthand hex and falls back to opaque white on garbage', () => {
    expect(assColor('#fff')).toBe('&H00FFFFFF')
    expect(assColor('#f00c')).toBe('&H330000FF') // #RGBA shorthand
    expect(assColor('not-a-color')).toBe('&H00FFFFFF')
    expect(assColor('#12345')).toBe('&H00FFFFFF') // wrong length
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
  it('emits the resolved \\fn font name and \\b0 (no libass faux-bold)', () => {
    const s = buildAss([overlay({ fontFamily: 'anton' })], target)
    expect(s).toContain(`\\fn${resolveFont('anton').assName}`) // \fnAnton
    expect(s).toContain('\\b0')
  })
  it('burns stroke via \\bord/\\3c only when the pill is off', () => {
    const withStroke = (pill: boolean): string =>
      buildAss([overlay({ pill: { enabled: pill, color: '#000000cc', padPx: 18 }, stroke: { widthPx: 8, color: '#000000' } })], target)
    expect(withStroke(false)).toContain('\\bord8')
    // pill on → stroke suppressed (the box owns \bord/\3c)
    expect(withStroke(true)).not.toContain('\\bord8')
  })
  it('burns shadow via \\shad/\\4c (+\\blur)', () => {
    const s = buildAss([overlay({ shadow: { distancePx: 3, color: '#000000', blur: 2 } })], target)
    expect(s).toContain('\\shad3')
    expect(s).toContain('\\blur2')
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

  describe('animations', () => {
    const anim = (a: Partial<import('@shared/textAnim').TextAnimation>): AssOverlay =>
      overlay({
        pill: { enabled: false, color: '#000000cc', padPx: 18 },
        animation: { in: 'none', inSec: 0.3, out: 'none', outSec: 0.3, ...a }
      })

    it('fade in + fade out ride one event as \\fad(inMs,outMs)', () => {
      const s = buildAss([anim({ in: 'fadeIn', inSec: 0.3, out: 'fadeOut', outSec: 0.5 })], target)
      expect(s).toContain('\\fad(300,500)')
      expect(s.match(/Dialogue:/g)?.length).toBe(1)
    })

    it('slide up maps to \\move from y+slide to y over the entrance', () => {
      const s = buildAss([anim({ in: 'slideUp', inSec: 0.35 })], target)
      expect(s).toContain('\\move(540,690,540,600,0,350)') // 90px logical @1920 target
      expect(s).toContain('\\fad(350,0)')
    })

    it('slide in + slide out split into entrance/static/exit events (one \\move each)', () => {
      const s = buildAss([anim({ in: 'slideUp', inSec: 0.3, out: 'slideDown', outSec: 0.4 })], target)
      const events = s.split('\n').filter((l) => l.startsWith('Dialogue:'))
      expect(events).toHaveLength(3)
      expect(events[0]).toContain('\\move(540,690,540,600,0,300)')
      expect(events[1]).toContain('\\pos(540,600)')
      expect(events[2]).toContain('\\move(540,600,540,690,0,400)')
      expect(events[2]).toContain('\\fad(0,400)')
      // Contiguous windows: entrance ends at 1.3, exit starts at 3.6.
      expect(events[0]).toContain(',0:00:01.00,0:00:01.30,')
      expect(events[1]).toContain(',0:00:01.30,0:00:03.60,')
      expect(events[2]).toContain(',0:00:03.60,0:00:04.00,')
    })

    it('typewriter emits one reveal event per char with layout-preserving alpha hides', () => {
      const s = buildAss([anim({ in: 'typewriter', inSec: 0.9, out: 'none' }), ], target)
      const events = s.split('\n').filter((l) => l.startsWith('Dialogue:'))
      // 'Hook line' = 9 chars → 9 reveal events + the static remainder.
      expect(events).toHaveLength(10)
      expect(events[0]).toContain('H{\\1a&HFF&\\3a&HFF&\\4a&HFF&}ook line')
      expect(events[8]).toContain('}Hook line') // full text, no hide marker
      expect(events[9]).toContain(',0:00:01.90,0:00:04.00,')
    })

    it('typewriter with a pill keeps the box (\\3a not hidden)', () => {
      const s = buildAss(
        [overlay({ animation: { in: 'typewriter', inSec: 0.9, out: 'none', outSec: 0.3 } })],
        target
      )
      expect(s).toContain('{\\1a&HFF&\\4a&HFF&}')
      expect(s).not.toContain('\\3a&HFF&')
    })

    it('word highlight emits one \\k per word with the dimmed secondary fill', () => {
      const s = buildAss(
        [anim({ in: 'wordHighlight', out: 'none' })], // 'Hook line' = 2 words over 3s
        target
      )
      expect(s).toContain('\\2c&H00FFFFFF&\\2a&H99&')
      expect(s).toContain('{\\k150}Hook {\\k150}line')
    })

    it('bounce emits the \\t scale pop with the shared keyframes', () => {
      const s = buildAss([anim({ in: 'bounce', inSec: 0.45, out: 'none' })], target)
      expect(s).toContain('\\fscx30\\fscy30')
      expect(s).toContain('\\t(0,270,\\fscx110\\fscy110)')
      expect(s).toContain('\\t(270,450,\\fscx100\\fscy100)')
      expect(s).toContain('\\fad(120,0)')
    })

    it('clamps entrance+exit that exceed the overlay duration proportionally', () => {
      // 3s overlay, 4s in + 2s out → scaled to 2s + 1s.
      const s = buildAss([anim({ in: 'fadeIn', inSec: 4, out: 'fadeOut', outSec: 2 })], target)
      expect(s).toContain('\\fad(2000,1000)')
    })

    it('a static overlay still emits the single un-animated event', () => {
      const s = buildAss([overlay()], target)
      expect(s.match(/Dialogue:/g)?.length).toBe(1)
      expect(s).not.toContain('\\fad')
    })
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

// Sparkles were verified by rendering the ACTUAL generated ASS over a black
// base and reading `signalstats` YAVG in a crop around one sparkle: it rose
// from the frame the event started, peaked at mid-life, and returned to
// baseline exactly as the event ended. See docs/FFMPEG-NOTES.md.
describe('sparkles', () => {
  const sparkle = {
    startSec: 1,
    endSec: 1.5,
    x: 300,
    y: 400,
    sizePx: 8,
    rotDeg: 45
  }

  it('declares the Sparkle style', () => {
    expect(buildAss([overlay()], target)).toContain('Style: Sparkle,')
  })

  it('draws sparkles on Layer 1 so they sit above the glyphs', () => {
    const ass = buildAss([overlay({ sparkles: [sparkle] })], target)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events.some((l) => l.startsWith('Dialogue: 1,') && l.includes('Sparkle'))).toBe(true)
    // The text itself stays on Layer 0.
    expect(events.some((l) => l.startsWith('Dialogue: 0,'))).toBe(true)
  })

  it('emits one event per sparkle', () => {
    const ass = buildAss([overlay({ sparkles: [sparkle, { ...sparkle, x: 500 }] })], target)
    expect(ass.split('\n').filter((l) => l.includes(',Sparkle,'))).toHaveLength(2)
  })

  it('pulses the drawing up at mid-life and back down', () => {
    const ass = buildAss([overlay({ sparkles: [sparkle] })], target)
    const line = ass.split('\n').find((l) => l.includes(',Sparkle,'))!
    // radius 8 on a radius-10 unit star => 80% at full, 40% of that at rest.
    expect(line).toContain('\\fscx32\\fscy32')
    expect(line).toContain('\\t(0,250,\\fscx80\\fscy80)')
    expect(line).toContain('\\t(250,500,\\fscx32\\fscy32)')
  })

  it('twinkles in and out over the sparkle life', () => {
    const line = buildAss([overlay({ sparkles: [sparkle] })], target)
      .split('\n')
      .find((l) => l.includes(',Sparkle,'))!
    expect(line).toContain('\\fad(250,250)')
  })

  it('carries the sparkle colour, defaulting to white', () => {
    const tinted = buildAss([overlay({ sparkles: [sparkle], sparkleColor: '#ffe08a' })], target)
    expect(tinted).toContain(`\\1c${assColor('#ffe08a')}&`)
    const plain = buildAss([overlay({ sparkles: [sparkle] })], target)
    expect(plain).toContain(`\\1c${assColor('#ffffff')}&`)
  })

  it('draws with no outline or shadow — a drawing is not a glyph', () => {
    const line = buildAss([overlay({ sparkles: [sparkle] })], target)
      .split('\n')
      .find((l) => l.includes(',Sparkle,'))!
    expect(line).toContain('\\bord0')
    expect(line).toContain('\\shad0')
    expect(line).toContain('\\p1')
    expect(line.endsWith('{\\p0}')).toBe(true)
  })

  it('still burns sparkles for a SPARKLE-ONLY overlay (text burned as a PNG)', () => {
    const ass = buildAss([overlay({ text: '', sparkles: [sparkle] })], target)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events).toHaveLength(1)
    expect(events[0]).toContain(',Sparkle,')
  })

  it('still drops an overlay that has neither text nor sparkles', () => {
    const ass = buildAss([overlay({ text: '   ' })], target)
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(0)
  })
})
