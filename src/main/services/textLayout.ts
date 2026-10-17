/**
 * PURE line layout for burned text blocks (text layers and captions alike).
 *
 * libass cannot reproduce the preview's line breaks or leading: it wraps with
 * its own glyph widths and spaces lines by the font's Windows metrics (1.3–1.9x
 * the size, where the preview uses 1.25 — see docs/FFMPEG-NOTES.md "libass text
 * metrics"). So Chromium lays the block out with the preview's own CSS
 * (`textImage.ts` → `measureBlocksScript`), and each line then burns as its own
 * libass event exactly where Chromium put it. This module turns the raw
 * per-character rects Chromium reports into those lines, and supplies the
 * fallback used if the layout pass is unavailable.
 */

import { TEXT_LINE_HEIGHT, assBaselineBelowPos } from '@shared/textStyle'

/** One laid-out line of a text block, in output px. */
export interface LaidOutLine {
  /** The visible run as [start, end) into the block text — edge whitespace
   *  (a soft-wrap space, the `\n`) excluded, so libass centres what Chromium
   *  centred. */
  start: number
  end: number
  /** Horizontal centre of the run. */
  cx: number
  /** Baseline y. */
  baseline: number
  /** The line's pill background box (top-left + size), when a pill is on —
   *  exactly the rect Chromium painted, padding included. */
  pill?: { x: number; y: number; w: number; h: number }
}

/** What the in-page measuring script reports for one block. */
export interface RawBlockMeasure {
  text: string
  /** The font's ascent as Chromium laid it out (baseline below a line's top). */
  ascent: number
  /** One rect per rendered character (code point), in text order. Characters
   *  with no box (a `\n`) are absent. */
  chars: { i: number; len: number; top: number; bottom: number; left: number; right: number }[]
  /** The pill span's per-line fragments (box-decoration-break: clone). */
  pills: { x: number; y: number; w: number; h: number }[]
}

/**
 * Group measured characters into lines, keep each line's visible run, and pair
 * each with the pill fragment centred on it. A new line starts where a
 * character's box sits more than half a box lower than its row's — NOT where it
 * clears the row's bottom: for faces whose text box is taller than the leading
 * (Poppins 1.40em, Pacifico 1.76em vs 1.25em) consecutive lines' boxes OVERLAP,
 * and a bottom test merged a whole wrapped block into one line. Blank lines
 * produce nothing — their space is already in the positions of the lines after
 * them.
 */
export function groupLines(m: RawBlockMeasure): LaidOutLine[] {
  const rows: { top: number; bottom: number; chars: RawBlockMeasure['chars'] }[] = []
  for (const c of m.chars) {
    const row = rows[rows.length - 1]
    if (row && c.top - row.top < (row.bottom - row.top) / 2) row.chars.push(c)
    else rows.push({ top: c.top, bottom: c.bottom, chars: [c] })
  }
  const out: LaidOutLine[] = []
  for (const row of rows) {
    const visible = row.chars.filter((c) => /\S/.test(m.text.slice(c.i, c.i + c.len)))
    if (visible.length === 0) continue
    const first = visible[0]
    const last = visible[visible.length - 1]
    const left = Math.min(...visible.map((c) => c.left))
    const right = Math.max(...visible.map((c) => c.right))
    const mid = (row.top + row.bottom) / 2
    const pill = m.pills.length
      ? m.pills.reduce((best, p) => (Math.abs(p.y + p.h / 2 - mid) < Math.abs(best.y + best.h / 2 - mid) ? p : best))
      : undefined
    out.push({
      start: first.i,
      end: last.i + last.len,
      cx: (left + right) / 2,
      baseline: row.top + m.ascent,
      ...(pill ? { pill } : {})
    })
  }
  return out
}

/**
 * Lines for a block when no Chromium layout is available (the hidden window
 * failed): explicit newlines only — no auto-wrap — at the preview's leading,
 * each centred on `x` and placed as libass would centre it on its row. The
 * text still burns, at the right size; only auto-wrapping is lost.
 */
export function fallbackLines(
  text: string,
  x: number,
  y: number,
  fontFamily: string,
  fontSizePx: number
): LaidOutLine[] {
  const parts = text.split('\n')
  const pitch = fontSizePx * TEXT_LINE_HEIGHT
  const drop = assBaselineBelowPos(fontFamily, fontSizePx)
  const out: LaidOutLine[] = []
  let pos = 0
  parts.forEach((part, i) => {
    const s = pos
    pos += part.length + 1
    if (part.trim().length === 0) return
    const lead = part.length - part.trimStart().length
    const trail = part.length - part.trimEnd().length
    const rowCentre = y + (i - (parts.length - 1) / 2) * pitch
    out.push({ start: s + lead, end: s + part.length - trail, cx: x, baseline: rowCentre + drop })
  })
  return out
}

/**
 * The measuring script run inside the layout page (see `buildLayoutHtml`):
 * for every `[data-block]` box, the per-character rects of its text, its pill
 * fragments and its ascent. Pure DOM; returns `RawBlockMeasure[]`.
 */
export const MEASURE_BLOCKS_SCRIPT = `(async () => {
  try { await document.fonts.ready } catch {}
  const out = []
  for (const box of document.querySelectorAll('[data-block]')) {
    const txt = box.querySelector('.txt')
    const node = txt && txt.firstChild
    const text = node ? node.data : ''
    const cs = getComputedStyle(box)
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.font = cs.fontSize + ' ' + cs.fontFamily
    const ascent = ctx.measureText('H').fontBoundingBoxAscent
    const chars = []
    const range = document.createRange()
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)
      const len = cp > 0xffff ? 2 : 1
      range.setStart(node, i)
      range.setEnd(node, i + len)
      const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0)
      if (rects.length) {
        const r = rects[rects.length - 1]
        chars.push({ i, len, top: r.top, bottom: r.bottom, left: r.left, right: r.right })
      }
      i += len
    }
    const pillEl = box.querySelector('.pill')
    const pills = pillEl
      ? Array.from(pillEl.getClientRects()).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
      : []
    out.push({ text, ascent, chars, pills })
  }
  return out
})()`
