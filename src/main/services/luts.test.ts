/**
 * A project's LUT store (`luts/`, content-named) against a real temp folder:
 * the same table stored by racing callers (two imports, a template drop) is
 * written ONCE — `writeAtomically`'s partial name is fixed, so the writes go
 * through `singleFlight` — and a table already there is not rewritten.
 */
import { existsSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

import { lutFileFor, storeLut } from './luts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reel-luts-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const TABLE = Buffer.from('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')

describe('storeLut', () => {
  it('racing stores of one table share one write; both get its name', async () => {
    const write = vi.spyOn(fsp, 'writeFile')
    const names = await Promise.all([storeLut(root, TABLE), storeLut(root, TABLE), storeLut(root, TABLE)])
    expect(new Set(names)).toEqual(new Set([lutFileFor(TABLE)]))
    expect(write).toHaveBeenCalledTimes(1)
    expect(readdirSync(join(root, 'luts'))).toEqual([lutFileFor(TABLE)])
    expect(readFileSync(join(root, 'luts', names[0]))).toEqual(TABLE)
  })

  it('does not rewrite a table that is already stored; a different table is its own file', async () => {
    await storeLut(root, TABLE)
    const write = vi.spyOn(fsp, 'writeFile')
    expect(await storeLut(root, TABLE)).toBe(lutFileFor(TABLE))
    expect(write).not.toHaveBeenCalled()
    const other = Buffer.from('LUT_1D_SIZE 2\n0 0 0\n1 1 0.5\n')
    const name = await storeLut(root, other)
    expect(name).not.toBe(lutFileFor(TABLE))
    expect(existsSync(join(root, 'luts', name))).toBe(true)
  })
})
