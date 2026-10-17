import { describe, it, expect } from 'vitest'
import { fallbackLines, groupLines, type RawBlockMeasure } from './textLayout'
import { assBaselineBelowPos } from '@shared/textStyle'

/** Fake per-char rects for `lines` of text laid out at a fixed advance. */
function measure(lines: string[], opts: { joiner?: string; pill?: boolean } = {}): RawBlockMeasure {
  const joiner = opts.joiner ?? ' '
  const text = lines.join(joiner)
  const chars: RawBlockMeasure['chars'] = []
  let i = 0
  lines.forEach((line, row) => {
    const top = 100 + row * 95
    const x0 = 540 - (line.length * 20) / 2
    for (let k = 0; k < line.length; k++)
      chars.push({ i: i + k, len: 1, top, bottom: top + 93, left: x0 + k * 20, right: x0 + (k + 1) * 20 })
    i += line.length
    if (row < lines.length - 1) {
      // the joiner: a soft-wrap space hangs at the end of its row; a newline has no box
      if (joiner === ' ')
        chars.push({ i, len: 1, top, bottom: top + 93, left: x0 + line.length * 20, right: x0 + line.length * 20 + 20 })
      i += joiner.length
    }
  })
  const pills = opts.pill
    ? lines.map((line, row) => ({
        x: 540 - (line.length * 20) / 2 - 18,
        y: 100 + row * 95 - 18,
        w: line.length * 20 + 36,
        h: 93 + 36
      }))
    : []
  return { text, ascent: 74, chars, pills }
}

describe('groupLines', () => {
  it('splits rows where characters move down, trimming the soft-wrap space', () => {
    const m = measure(['Hook text', 'stays put'])
    const lines = groupLines(m)
    expect(lines).toHaveLength(2)
    expect(m.text.slice(lines[0].start, lines[0].end)).toBe('Hook text')
    expect(m.text.slice(lines[1].start, lines[1].end)).toBe('stays put')
    // centre of the visible run (the hanging space is excluded), baseline = top + ascent
    expect(lines[0].cx).toBe(540)
    expect(lines[0].baseline).toBe(174)
    expect(lines[1].baseline).toBe(269)
  })

  it('splits lines whose text boxes OVERLAP (a face taller than the leading)', () => {
    // Poppins at 64px: 90px text boxes on an 80px line pitch — the second line's
    // box starts ABOVE the first one's bottom. Measured merging a wrapped block.
    const m = measure(['this hook is', 'long enough'])
    const tall = {
      ...m,
      chars: m.chars.map((c) => (c.top > 100 ? { ...c, top: 180, bottom: 270 } : { ...c, bottom: 190 }))
    }
    expect(groupLines(tall)).toHaveLength(2)
  })

  it('handles explicit newlines (no box for the \\n)', () => {
    const m = measure(['one', 'two'], { joiner: '\n' })
    const lines = groupLines(m)
    expect(lines.map((l) => m.text.slice(l.start, l.end))).toEqual(['one', 'two'])
  })

  it('pairs each line with the pill fragment centred on it', () => {
    const lines = groupLines(measure(['Hook text stays', 'put'], { pill: true }))
    expect(lines[0].pill).toEqual({ x: 540 - 150 - 18, y: 82, w: 336, h: 129 })
    expect(lines[1].pill).toEqual({ x: 540 - 30 - 18, y: 177, w: 96, h: 129 })
  })

  it('drops rows with nothing visible', () => {
    const m: RawBlockMeasure = {
      text: '  ',
      ascent: 74,
      chars: [
        { i: 0, len: 1, top: 0, bottom: 93, left: 0, right: 10 },
        { i: 1, len: 1, top: 0, bottom: 93, left: 10, right: 20 }
      ],
      pills: []
    }
    expect(groupLines(m)).toEqual([])
  })
})

describe('fallbackLines', () => {
  it('a single line sits where libass centres it on (x, y)', () => {
    const [l] = fallbackLines('Hook', 540, 600, 'montserrat-extrabold', 80)
    expect(l).toEqual({ start: 0, end: 4, cx: 540, baseline: 600 + assBaselineBelowPos('montserrat-extrabold', 80) })
  })

  it('explicit lines stack at the preview leading around y, blank lines keep their slot', () => {
    const ls = fallbackLines('a\n\nb', 540, 600, 'montserrat-extrabold', 80)
    const drop = assBaselineBelowPos('montserrat-extrabold', 80)
    expect(ls.map((l) => [l.start, l.end, l.baseline - drop])).toEqual([
      [0, 1, 500],
      [3, 4, 700]
    ])
  })
})
