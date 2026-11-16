import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bakeGradeTable, GRADE_TABLE_SIZE, type ColorLook } from '@shared/grade'
import { parseCube, writeCube } from '@shared/cube'
import { gradeFilter } from './ffmpegFilters'
import { lookFilter, lut3dFilter } from './exportGrade'
import { importLut, lutFileFor, readLut } from './luts'

let dir: string
let root: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-grade-'))
  root = mkdtempSync(join(tmpdir(), 'reel-proj-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

const g = (brightness: number, contrast = 1, saturation = 1) => ({ brightness, contrast, saturation })
/** A small warm 2-point table: red up, blue down. */
const WARM =
  'TITLE "Warm"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 0.8\r\n1 0 0.8\r\n0 1 0.8\r\n1 1 0.8\r\n'

describe('lookFilter', () => {
  it('keeps today’s exact lutrgb / colorchannelmixer strings for the old sliders and the wash, writing nothing', async () => {
    const looks: ColorLook[] = [
      {},
      { color: g(0.2) },
      { color: g(0.15, 1.3, 1.4), tint: { color: '#ffd999', amount: 0.5 } },
      { color: { ...g(0, 1.5), temperature: 0, vibrance: 0 } },
      { tint: { color: '#e8c290', amount: 0.6 }, lut: { file: 'x.cube', name: 'X', strength: 0 } }
    ]
    for (const look of looks) expect(await lookFilter(look, dir, root)).toBe(gradeFilter(look.color, look.tint))
    expect(await lookFilter({ color: g(0.2) }, dir, root)).toBe(
      "lutrgb=r='clip(val*1.2,0,maxval)':g='clip(val*1.2,0,maxval)':b='clip(val*1.2,0,maxval)'"
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('bakes a look with a newer control into one table file in the render folder, applied by lut3d', async () => {
    const look: ColorLook = { color: { ...g(0.2, 1.2), temperature: 0.5 }, tint: { color: '#ffd999', amount: 0.3 } }
    const f = await lookFilter(look, dir, root)
    const [file] = readdirSync(dir)
    expect(file).toMatch(/^grade_[0-9a-f]{12}\.cube$/)
    expect(f).toBe(lut3dFilter(file))
    expect(f).toBe(`lut3d=file=${file}:interp=tetrahedral`)
    const written = parseCube(readFileSync(join(dir, file), 'utf8'))
    expect(written.size).toBe(GRADE_TABLE_SIZE)
    expect(Array.from(written.data)).toEqual(Array.from(bakeGradeTable(look, null)))
    // The same look again reuses the file; a different one adds another.
    expect(await lookFilter(look, dir, root)).toBe(f)
    await lookFilter({ color: { ...g(0), vibrance: 0.4 } }, dir, root)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('reads the LUT from the project’s luts folder and bakes it at its strength', async () => {
    const src = join(dir, 'My_Warm look.cube')
    writeFileSync(src, WARM)
    const imported = await importLut(root, src)
    expect(imported).toEqual({ file: lutFileFor(Buffer.from(WARM, 'latin1')), name: 'My Warm look' })
    expect(readdirSync(join(root, 'luts'))).toEqual([imported.file])
    const look: ColorLook = { lut: { ...imported, strength: 0.5 } }
    const f = await lookFilter(look, dir, root)
    const file = f.match(/file=(\S+?):/)![1]
    const table = parseCube(readFileSync(join(dir, file), 'utf8'))
    expect(Array.from(table.data)).toEqual(Array.from(bakeGradeTable(look, await readLut(root, imported.file))))
    // Mid grey at half strength: blue 0.5 → 0.4 in the LUT → 0.45 mixed.
    const mid = ((32 * GRADE_TABLE_SIZE + 32) * GRADE_TABLE_SIZE + 32) * 3
    expect(table.data[mid + 2]).toBeCloseTo(0.45, 5)
  })

  it('fails with the LUT’s name when its file has gone, rather than exporting without it', async () => {
    const look: ColorLook = { lut: { file: '0123456789abcdef.cube', name: 'Teal & orange', strength: 1 } }
    await expect(lookFilter(look, dir, root)).rejects.toThrow(/Teal & orange.*missing/)
  })

  it('never reads a stored name that is not one the editor writes', async () => {
    mkdirSync(join(root, 'luts'))
    writeFileSync(join(root, 'secret.cube'), WARM)
    const look: ColorLook = { lut: { file: '../secret.cube', name: 'Sneaky', strength: 1 } }
    await expect(lookFilter(look, dir, root)).rejects.toThrow(/not a LUT name/)
  })
})

describe('importLut', () => {
  it('refuses a file that is not a usable table, with the reason, and copies nothing', async () => {
    const bad = join(dir, 'broken.cube')
    writeFileSync(bad, 'LUT_3D_SIZE 2\n0 0 0\n')
    await expect(importLut(root, bad)).rejects.toThrow(/broken\.cube.*should have 8 entries/)
    await expect(importLut(root, join(dir, 'nope.cube'))).rejects.toThrow(/could not be found/)
    expect(() => readdirSync(join(root, 'luts'))).toThrow()
  })

  it('stores the same table once however often it is imported', async () => {
    const a = join(dir, 'a.cube')
    const b = join(dir, 'b.cube')
    writeFileSync(a, WARM)
    writeFileSync(b, WARM)
    const first = await importLut(root, a)
    const second = await importLut(root, b)
    expect(second.file).toBe(first.file)
    expect(second.name).toBe('b')
    expect(readdirSync(join(root, 'luts'))).toHaveLength(1)
    expect(writeCube(2, (await readLut(root, first.file)).data)).toContain('LUT_3D_SIZE 2')
  })
})
