import { describe, it, expect } from 'vitest'
import { buildAss, assColor, pillPath, type AssOverlay } from './assBuilder'
import type { LaidOutLine } from './textLayout'
import { DEFAULT_FONT_ID, resolveFont } from '@shared/fonts'
import { assBaselineBelowPos } from '@shared/textStyle'

const FS = 80
/** libass's centre-to-baseline drop for the default face at FS. */
const drop = assBaselineBelowPos(DEFAULT_FONT_ID, FS)

/** A block as Chromium lays it out: by default one line centred on (540, 600). */
function overlay(over: Partial<AssOverlay> = {}): AssOverlay {
  return {
    text: 'Hook line',
    startSec: 1,
    endSec: 4,
    x: 540,
    y: 600,
    fontFamily: DEFAULT_FONT_ID,
    fontSizePx: FS,
    color: '#ffffff',
    pill: { enabled: false, color: '#000000cc', padPx: 18 },
    lines: [{ start: 0, end: 9, cx: 540, baseline: 600 + drop }],
    ...over
  }
}

/** Two laid-out lines of 'Hook text stays put' (break after "text"), 95px apart. */
const TWO = 'Hook text stays put'
const twoLines = (pill = false): LaidOutLine[] => [
  { start: 0, end: 9, cx: 540, baseline: 552 + drop, ...(pill ? { pill: { x: 380, y: 487, w: 320, h: 130 } } : {}) },
  { start: 10, end: 19, cx: 540, baseline: 647 + drop, ...(pill ? { pill: { x: 385, y: 582, w: 310, h: 130 } } : {}) }
]

const target = { width: 1080, height: 1920 }
const events = (ass: string): string[] => ass.split('\n').filter((l) => l.startsWith('Dialogue:'))

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
  it('sets PlayRes to the target and never lets libass re-wrap', () => {
    const s = buildAss([overlay()], target)
    expect(s).toContain('PlayResX: 1080')
    expect(s).toContain('PlayResY: 1920')
    // Lines arrive laid out by Chromium; libass wrapping would re-break them.
    expect(s).toContain('WrapStyle: 2')
  })

  it('emits a Dialogue with timing, position, size and colour', () => {
    const s = buildAss([overlay()], target)
    expect(s).toContain('Dialogue: 1,0:00:01.00,0:00:04.00,Plain')
    expect(s).toContain('\\pos(540,600)')
    expect(s).toContain('\\c&HFFFFFF&')
    expect(s).toContain('Hook line')
  })

  it('sizes glyphs for libass: \\fs = the CSS size x the face’s Windows line height', () => {
    // libass scales a face so winAscent + winDescent = \fs; CSS sizes the em.
    // Montserrat ExtraBold: (1109 + 453) / 1000 → 80px CSS = \fs125 (was \fs80,
    // i.e. 0.64x the preview). Every face has its own factor.
    expect(buildAss([overlay()], target)).toContain('\\fs125')
    const anton = resolveFont('anton').win
    const fs = (80 * (anton.ascent + anton.descent)) / anton.unitsPerEm // 138.67
    expect(buildAss([overlay({ fontFamily: 'anton' })], target)).toContain(`\\fs${Math.round(fs * 10) / 10}`)
  })

  it('burns one event per laid-out line, each at its own measured position', () => {
    const ev = events(buildAss([overlay({ text: TWO, lines: twoLines() })], target))
    expect(ev).toHaveLength(2)
    // \pos = measured baseline less libass's centre-to-baseline drop
    expect(ev[0]).toContain('\\pos(540,552)')
    expect(ev[0].endsWith('}Hook text')).toBe(true)
    expect(ev[1]).toContain('\\pos(540,647)')
    expect(ev[1].endsWith('}stays put')).toBe(true)
  })

  it('without a layout, falls back to newline-only lines centred on (x, y)', () => {
    const one = events(buildAss([overlay({ lines: undefined })], target))
    expect(one).toHaveLength(1)
    expect(one[0]).toContain('\\pos(540,600)')
    const two = events(buildAss([overlay({ text: 'a\nb', lines: undefined })], target))
    expect(two.map((e) => e.slice(e.lastIndexOf('}') + 1))).toEqual(['a', 'b'])
  })

  it('emits the resolved \\fn font name and \\b0 (no libass faux-bold)', () => {
    const s = buildAss([overlay({ fontFamily: 'anton' })], target)
    expect(s).toContain(`\\fn${resolveFont('anton').assName}`) // \fnAnton
    expect(s).toContain('\\b0')
  })

  it('burns an outline at HALF its CSS width, and none under a pill', () => {
    // CSS centres the stroke on the glyph edge and paint-order hides the inner
    // half; libass draws \bord wholly outside — verified 8px CSS ≈ 4px visible.
    const withStroke = (pill: boolean): string =>
      buildAss([overlay({ pill: { enabled: pill, color: '#000000cc', padPx: 18 }, stroke: { widthPx: 8, color: '#000000' } })], target)
    expect(withStroke(false)).toContain('\\bord4\\3c&H000000&')
    expect(withStroke(true)).not.toContain('\\bord4')
  })

  it('burns shadow via \\shad/\\4c (+\\blur)', () => {
    const s = buildAss([overlay({ shadow: { distancePx: 3, color: '#000000', blur: 2 } })], target)
    expect(s).toContain('\\shad3')
    expect(s).toContain('\\blur2')
  })

  it('gives undecorated text the default legibility shadow, like the preview', () => {
    const plain = buildAss([overlay()], target)
    expect(plain).toContain('\\yshad2.7')
    expect(plain).toContain('\\blur3.2')
    // …scaled with the layer/output, and absent whenever something else
    // separates the text (a pill, an outline, a shadow).
    expect(buildAss([overlay({ decoScale: 2 })], target)).toContain('\\yshad5.4')
    expect(buildAss([overlay({ pill: { enabled: true, color: '#000000cc', padPx: 18 } })], target)).not.toContain('\\yshad')
    expect(buildAss([overlay({ stroke: { widthPx: 6, color: '#000000' } })], target)).not.toContain('\\yshad')
  })

  it('carries a translucent text colour as \\1a (colour tags drop alpha)', () => {
    expect(buildAss([overlay({ color: '#ffffff80' })], target)).toContain('\\c&HFFFFFF&\\1a&H7F&')
  })

  describe('pill', () => {
    const pilled = (lines = twoLines(true)): string =>
      buildAss([overlay({ text: TWO, lines, pill: { enabled: true, color: '#000000cc', padPx: 18 } })], target)

    it('draws each line’s measured box as a rounded vector shape on Layer 0, under the glyphs', () => {
      const ev = events(pilled())
      const boxes = ev.filter((e) => e.startsWith('Dialogue: 0,'))
      const glyphs = ev.filter((e) => e.startsWith('Dialogue: 1,'))
      expect(boxes).toHaveLength(2)
      expect(glyphs).toHaveLength(2)
      // centred on the box Chromium measured (380,487 320x130 → centre 540,552)
      expect(boxes[0]).toContain('\\pos(540,552)')
      expect(boxes[0]).toContain(`{\\p1}${pillPath(320, 130, 11)}{\\p0}`) // radius = pillRadiusPx(18)
      expect(boxes[1]).toContain(`{\\p1}${pillPath(310, 130, 11)}{\\p0}`)
      // glyphs burn plain — no libass box
      expect(glyphs[0]).toContain(',Plain,')
    })

    it('keeps the pill’s alpha (a #000000cc pill is 80% opaque, not solid)', () => {
      const box = events(pilled())[0]
      expect(box).toContain('\\1c&H000000&\\1a&H33&')
    })

    it('falls back to libass’s own box when the layout measured none', () => {
      const s = buildAss([overlay({ lines: undefined, pill: { enabled: true, color: '#000000cc', padPx: 18 } })], target)
      const [ev] = events(s)
      expect(ev).toContain(',Pill,')
      expect(ev).toContain('\\3c&H000000&\\3a&H33&\\bord18')
    })

    it('rounds the path corners with cubic beziers, clamped to the box', () => {
      expect(pillPath(100, 40, 11)).toMatch(/^m 11 0 l 89 0 b /)
      expect(pillPath(100, 10, 11)).toMatch(/^m 5 0 /) // radius ≤ half the height
    })
  })

  it('rotates every piece of a block about its centre (captions)', () => {
    const s = buildAss(
      [overlay({ text: TWO, lines: twoLines(true), rotationDeg: 15, pill: { enabled: true, color: '#000000cc', padPx: 18 } })],
      target
    )
    const ev = events(s)
    expect(ev).toHaveLength(4)
    // ASS rotates counter-clockwise; ours is clockwise → -15, about (x, y)
    for (const e of ev) expect(e).toContain('\\org(540,600)\\frz-15')
  })

  it('skips empty overlays and never emits a newline inside an event', () => {
    expect(buildAss([overlay({ text: '   ', lines: [] })], target)).not.toContain('Dialogue:')
    expect(buildAss([overlay({ text: 'a\nb', lines: undefined })], target)).not.toContain('\\N')
  })

  describe('animations', () => {
    const anim = (a: Partial<import('@shared/textAnim').TextAnimation>, over: Partial<AssOverlay> = {}): AssOverlay =>
      overlay({ animation: { in: 'none', inSec: 0.3, out: 'none', outSec: 0.3, ...a }, ...over })

    it('fade in + fade out ride one event as \\fad(inMs,outMs)', () => {
      const s = buildAss([anim({ in: 'fadeIn', inSec: 0.3, out: 'fadeOut', outSec: 0.5 })], target)
      expect(s).toContain('\\fad(300,500)')
      expect(events(s)).toHaveLength(1)
    })

    it('slide up maps to \\move from y+slide to y over the entrance', () => {
      const s = buildAss([anim({ in: 'slideUp', inSec: 0.35 })], target)
      expect(s).toContain('\\move(540,690,540,600,0,350)') // 90px logical @1920 target
      expect(s).toContain('\\fad(350,0)')
    })

    it('slide travel follows the output scale, not the target height', () => {
      // A 16:9 target renders 1:1 — the travel must NOT shrink to 90×1080/1920.
      const wide = buildAss([anim({ in: 'slideUp', inSec: 0.35 })], { width: 1920, height: 1080 })
      expect(wide).toContain('\\move(540,690,540,600,0,350)')
      // A half-resolution render halves it.
      const half = buildAss([anim({ in: 'slideUp', inSec: 0.35 })], target, 0.5)
      expect(half).toContain('\\move(540,645,540,600,0,350)')
    })

    it('slide in + slide out split into entrance/static/exit events (one \\move each)', () => {
      const ev = events(buildAss([anim({ in: 'slideUp', inSec: 0.3, out: 'slideDown', outSec: 0.4 })], target))
      expect(ev).toHaveLength(3)
      expect(ev[0]).toContain('\\move(540,690,540,600,0,300)')
      expect(ev[1]).toContain('\\pos(540,600)')
      expect(ev[2]).toContain('\\move(540,600,540,690,0,400)')
      expect(ev[2]).toContain('\\fad(0,400)')
      // Contiguous windows: entrance ends at 1.3, exit starts at 3.6.
      expect(ev[0]).toContain(',0:00:01.00,0:00:01.30,')
      expect(ev[1]).toContain(',0:00:01.30,0:00:03.60,')
      expect(ev[2]).toContain(',0:00:03.60,0:00:04.00,')
    })

    it('slides every line of a multi-line block by the same travel', () => {
      const ev = events(buildAss([anim({ in: 'slideUp', inSec: 0.35 }, { text: TWO, lines: twoLines() })], target))
      expect(ev[0]).toContain('\\move(540,642,540,552,0,350)')
      expect(ev[1]).toContain('\\move(540,737,540,647,0,350)')
    })

    it('typewriter emits one reveal event per char with layout-preserving alpha hides', () => {
      const ev = events(buildAss([anim({ in: 'typewriter', inSec: 0.9, out: 'none' })], target))
      // 'Hook line' = 9 chars → 9 reveal events + the static remainder.
      expect(ev).toHaveLength(10)
      expect(ev[0]).toContain('H{\\1a&HFF&\\3a&HFF&\\4a&HFF&}ook line')
      expect(ev[8]).toContain('}Hook line') // full text, no hide marker
      expect(ev[9]).toContain(',0:00:01.90,0:00:04.00,')
    })

    it('typewriter reveals line by line: a line waits for the text before it', () => {
      // 'ab cd' → steps of 1 char over 0.5s (0.1s each); line 2 starts at char 3.
      const lines: LaidOutLine[] = [
        { start: 0, end: 2, cx: 540, baseline: 552 + drop },
        { start: 3, end: 5, cx: 540, baseline: 647 + drop }
      ]
      const ev = events(buildAss([anim({ in: 'typewriter', inSec: 0.5, out: 'none' }, { text: 'ab cd', lines })], target))
      const line1 = ev.filter((e) => e.includes('\\pos(540,552)'))
      const line2 = ev.filter((e) => e.includes('\\pos(540,647)'))
      // line 1: "a" (0–0.1s), then whole from 0.1s — merged, not one per step
      expect(line1[0]).toContain(',0:00:01.00,0:00:01.10,')
      expect(line1[1]).toContain(',0:00:01.10,0:00:01.50,')
      expect(line1[1].endsWith('}ab')).toBe(true)
      // line 2: nothing until the 4th step (char 4 = "c")
      expect(line2[0]).toContain(',0:00:01.30,0:00:01.40,')
      expect(line2[0]).toContain('c{\\1a&HFF&\\3a&HFF&\\4a&HFF&}d')
    })

    it('typewriter keeps the pill box up for the whole reveal', () => {
      const s = buildAss(
        [anim({ in: 'typewriter', inSec: 0.9, out: 'none' }, { text: TWO, lines: twoLines(true), pill: { enabled: true, color: '#000000cc', padPx: 18 } })],
        target
      )
      const boxes = events(s).filter((e) => e.startsWith('Dialogue: 0,'))
      expect(boxes).toHaveLength(2)
      for (const b of boxes) expect(b).toContain(',0:00:01.00,0:00:04.00,')
    })

    it('word highlight emits one \\k per word with the dimmed secondary fill', () => {
      const s = buildAss([anim({ in: 'wordHighlight', out: 'none' })], target) // 'Hook line' = 2 words over 3s
      expect(s).toContain('\\2c&HFFFFFF&\\2a&H99&')
      expect(s).toContain('{\\k150}Hook {\\k150}line')
    })

    it('word highlight opens each later line with a \\k delay for the words before it', () => {
      // 4 words over 3s = 75cs each; line 2 starts at word 3.
      const ev = events(buildAss([anim({ in: 'wordHighlight', out: 'none' }, { text: TWO, lines: twoLines() })], target))
      expect(ev[0].endsWith('}{\\k75}Hook {\\k75}text')).toBe(true)
      expect(ev[1].endsWith('}{\\k150}{\\k75}stays {\\k75}put')).toBe(true)
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
      expect(events(s)).toHaveLength(1)
      expect(s).not.toContain('\\fad')
    })
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

  it('draws sparkles on Layer 2 so they sit above the glyphs (1) and pills (0)', () => {
    const ev = events(buildAss([overlay({ sparkles: [sparkle] })], target))
    expect(ev.some((l) => l.startsWith('Dialogue: 2,') && l.includes('Sparkle'))).toBe(true)
    expect(ev.some((l) => l.startsWith('Dialogue: 1,') && l.includes('Plain'))).toBe(true)
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

// Straight-line motion (text-layer keyframes → `AssOverlay.motion`). Each tag
// used here was verified against the real libass: a windowed \move holds before
// and after its window, a \move under a fixed \org travels along the ROTATED
// axis, and \fade continues a partial \fad across split events exactly. See
// docs/FFMPEG-NOTES.md "Straight-line motion".
describe('straight-line motion', () => {
  // The block (laid out at 540,600) travels +200px right between t 2 and 3.
  const travel = { t0: 2, t1: 3, x0: 0, y0: 0, x1: 200, y1: 0 }

  it('a static block becomes ONE windowed \\move (no split)', () => {
    const ev = events(buildAss([overlay({ motion: travel })], target))
    expect(ev).toHaveLength(1)
    // Event 1..4s: sits at the start until 1000ms, arrives at 2000ms, holds.
    expect(ev[0]).toContain('\\move(540,600,740,600,1000,2000)')
    expect(ev[0]).not.toContain('\\pos(')
  })

  it('an event wholly before or after the travel is a plain \\pos at that end', () => {
    const before = events(buildAss([overlay({ startSec: 0, endSec: 1.5, motion: travel })], target))
    expect(before[0]).toContain('\\pos(540,600)')
    const after = events(buildAss([overlay({ startSec: 3.5, endSec: 4, motion: travel })], target))
    expect(after[0]).toContain('\\pos(740,600)')
  })

  it('turns the travel into the block axes when the block is rotated (fixed \\org)', () => {
    // At 90° clockwise, +200 on SCREEN x is written as -200 on the block's y
    // (R⁻¹·d), which libass then turns back onto the screen about \org.
    const ev = events(buildAss([overlay({ motion: travel, rotationDeg: 90 })], target))
    expect(ev[0]).toContain('\\move(540,600,540,400,1000,2000)')
    expect(ev[0]).toContain('\\org(540,600)')
  })

  it('keeps the other animations on their single event (bounce, fade)', () => {
    const anim = { in: 'bounce' as const, inSec: 0.45, out: 'fadeOut' as const, outSec: 0.3 }
    const ev = events(buildAss([overlay({ motion: travel, animation: anim })], target))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toContain('\\move(540,600,740,600,1000,2000)')
    expect(ev[0]).toContain('\\t(0,')
  })

  it('a slide that overlaps the travel splits at every breakpoint, continuing the fade with \\fade', () => {
    // A 2s slide-in over a 1..4s block, travelling 1.5..2.5.
    const early = { t0: 1.5, t1: 2.5, x0: 0, y0: 0, x1: 100, y1: 0 }
    const anim = { in: 'slideUp' as const, inSec: 2, out: 'none' as const, outSec: 0.3 }
    const ev = events(buildAss([overlay({ motion: early, animation: anim })], target))
    // Cuts: 1, 1.5 (travel start), 2.5 (travel end), 3 (slide + fade end), 4.
    expect(ev).toHaveLength(4)
    // First piece: no travel yet, the slide from +90 toward its 1.5s value, fading in.
    expect(ev[0]).toContain('0:00:01.00,0:00:01.50')
    expect(ev[0]).toContain('\\move(540,690,540,668,0,500)')
    expect(ev[0]).toContain('\\fade(255,191,191,0,500,500,500)')
    // Second: travel 0→100 while the slide continues.
    expect(ev[1]).toContain('\\move(540,668,640,623,0,1000)')
    // Last: slide done, travel done, fully faded in — no \fade.
    expect(ev[3]).toContain('\\move(640,600,640,600,0,1000)')
    expect(ev[3]).not.toContain('\\fade')
  })

  it('slide events the travel does not cross keep their exact form (offset to where the travel is)', () => {
    // Slide in (1..1.3) and out (3.7..4); travel 2..3 falls in the static middle.
    const anim = { in: 'slideUp' as const, inSec: 0.3, out: 'slideDown' as const, outSec: 0.3 }
    const ev = events(buildAss([overlay({ motion: travel, animation: anim })], target))
    expect(ev).toHaveLength(3)
    expect(ev[0]).toContain('\\move(540,690,540,600,0,300)')
    expect(ev[0]).toContain('\\fad(300,0)')
    expect(ev[1]).toContain('\\move(540,600,740,600,700,1700)')
    expect(ev[2]).toContain('\\move(740,600,740,690,0,300)')
    expect(ev[2]).toContain('\\fad(0,300)')
  })

  it('sparkles ride the travel in SCREEN space (they are not rotated about \\org)', () => {
    const sparkle = { startSec: 2, endSec: 3, x: 300, y: 400, sizePx: 8, rotDeg: 0 }
    const ev = events(buildAss([overlay({ motion: travel, rotationDeg: 90, sparkles: [sparkle] })], target))
    const sp = ev.find((l) => l.includes('Sparkle'))!
    expect(sp).toContain('\\move(300,400,500,400,0,1000)')
  })
})
