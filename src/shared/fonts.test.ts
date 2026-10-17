import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FONTS } from './fonts'

const FONTS_DIR = join(__dirname, '..', '..', 'resources', 'fonts')

/** The OS/2 Windows metrics + unitsPerEm straight out of a TTF's tables. */
function readWinMetrics(file: string): { ascent: number; descent: number; unitsPerEm: number } {
  const b = readFileSync(join(FONTS_DIR, file))
  const tables = new Map<string, number>()
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const o = 12 + i * 16
    tables.set(b.toString('latin1', o, o + 4), b.readUInt32BE(o + 8))
  }
  const head = tables.get('head')!
  const os2 = tables.get('OS/2')!
  return {
    ascent: b.readUInt16BE(os2 + 74), // usWinAscent
    descent: b.readUInt16BE(os2 + 76), // usWinDescent
    unitsPerEm: b.readUInt16BE(head + 18)
  }
}

describe('font catalog', () => {
  it('ships a file for every catalog entry, and an entry for every file', () => {
    const files = readdirSync(FONTS_DIR)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .sort()
    expect(FONTS.map((f) => f.file).sort()).toEqual(files)
  })

  it('carries each face’s real Windows metrics (what libass sizes text by)', () => {
    for (const f of FONTS) expect({ id: f.id, ...f.win }).toEqual({ id: f.id, ...readWinMetrics(f.file) })
  })
})
