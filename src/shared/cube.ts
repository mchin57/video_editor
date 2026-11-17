/**
 * `.cube` colour lookup tables (Adobe / Resolve format): read a user's file,
 * sample it, and write the editor's own baked tables. A user's file is NEVER
 * handed to ffmpeg as is: it is parsed here and baked, with the rest of the
 * clip's grade, into ONE table (`bakeGradeTable`, shared/grade.ts) that the
 * export applies with `lut3d` and the preview with WebGL — so the quirks of
 * real files (CRLF, `TITLE`, comments, `DOMAIN_MIN`/`DOMAIN_MAX`, 1D tables)
 * are handled once, on both sides alike. What real free packs contain is in
 * docs/FFMPEG-NOTES.md "Colour table".
 *
 * Data order is the format's: red changes fastest, then green, then blue.
 * Pure — main (import, export) and the renderer (preview) share it.
 */

import { clamp01 } from './math'

/** A parsed table. 3D: `size`³ RGB entries; 1D: `size` RGB entries (one curve per channel). */
export interface CubeTable {
  kind: '3d' | '1d'
  size: number
  /** RGB triples in file order (red fastest), as written in the file (not clamped). */
  data: Float32Array
  /** The input range the grid spans, per channel (the format's default is 0..1). */
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title?: string
}

/** Sizes accepted. ffmpeg's `lut3d` takes up to 256 points; real files are 17–65. */
export const MAX_CUBE_3D_SIZE = 256
export const MAX_CUBE_1D_SIZE = 65536

/** Why a file can't be used, in words for the person who picked it. */
export class CubeError extends Error {}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

function triple(parts: string[], line: number, what: string): [number, number, number] {
  if (parts.length !== 3 || !parts.every((p) => NUM.test(p))) {
    throw new CubeError(`Line ${line}: ${what} needs three numbers.`)
  }
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])]
}

/**
 * Read a `.cube` file's text. Throws `CubeError` (with the line number where
 * it helps) for anything we can't use: no size, a size out of range, a file
 * with both a 1D and a 3D table, a line that isn't three numbers, too few or
 * too many entries, or an empty domain.
 */
export function parseCube(text: string): CubeTable {
  let size3 = 0
  let size1 = 0
  let title: string | undefined
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const values: number[] = []
  // A UTF-8 byte-order mark (U+FEFF) some editors write is not part of the first line.
  const lines = text.replace(new RegExp('^\\uFEFF'), '').split(/\r\n|\r|\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const n = i + 1
    const parts = line.split(/\s+/)
    const key = parts[0]
    if (/^[A-Za-z_]/.test(key)) {
      if (values.length) throw new CubeError(`Line ${n}: "${key}" comes after the table data.`)
      const rest = parts.slice(1)
      switch (key.toUpperCase()) {
        case 'TITLE':
          title = line
            .slice(5)
            .trim()
            .replace(/^"(.*)"$/, '$1')
          break
        case 'LUT_3D_SIZE':
          size3 = sizeOf(rest, n, 2, MAX_CUBE_3D_SIZE)
          break
        case 'LUT_1D_SIZE':
          size1 = sizeOf(rest, n, 2, MAX_CUBE_1D_SIZE)
          break
        case 'DOMAIN_MIN':
          domainMin = triple(rest, n, 'DOMAIN_MIN')
          break
        case 'DOMAIN_MAX':
          domainMax = triple(rest, n, 'DOMAIN_MAX')
          break
        case 'LUT_3D_INPUT_RANGE':
        case 'LUT_1D_INPUT_RANGE': {
          // Resolve's spelling of a domain: one min and one max for all channels.
          if (rest.length !== 2 || !rest.every((p) => NUM.test(p))) {
            throw new CubeError(`Line ${n}: ${key} needs two numbers.`)
          }
          const [lo, hi] = rest.map(Number)
          domainMin = [lo, lo, lo]
          domainMax = [hi, hi, hi]
          break
        }
        default:
          // Other keywords (vendor extensions) carry nothing we use.
          break
      }
      continue
    }
    const v = triple(parts, n, 'A table entry')
    values.push(v[0], v[1], v[2])
  }
  if (size3 && size1) throw new CubeError('This file has both a 1D and a 3D table, which isn’t supported.')
  if (!size3 && !size1) throw new CubeError('Not a .cube table: there is no LUT_3D_SIZE or LUT_1D_SIZE line.')
  const kind = size3 ? '3d' : '1d'
  const size = size3 || size1
  const expected = (kind === '3d' ? size ** 3 : size) * 3
  if (values.length !== expected) {
    throw new CubeError(
      `The table should have ${expected / 3} entries for its size (${size}) but has ${values.length / 3}.`
    )
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) throw new CubeError('DOMAIN_MAX must be above DOMAIN_MIN.')
  }
  if (values.some((v) => !Number.isFinite(v))) throw new CubeError('The table has a number that is out of range.')
  return { kind, size, data: Float32Array.from(values), domainMin, domainMax, ...(title ? { title } : {}) }
}

function sizeOf(rest: string[], line: number, lo: number, hi: number): number {
  const v = rest.length === 1 && /^\d+$/.test(rest[0]) ? Number(rest[0]) : NaN
  if (!(v >= lo && v <= hi))
    throw new CubeError(`Line ${line}: the table size must be a whole number from ${lo} to ${hi}.`)
  return v
}

/** Round to 6 places — what a written table holds, and what the grade (shared/grade.ts) rounds its
 *  curve and matrices to, so the preview, the export strings and the tests all see the same numbers. */
export const n6 = (v: number): number => Math.round(v * 1e6) / 1e6

/** A 3D table as `.cube` text: `LUT_3D_SIZE` then one `r g b` line per entry (6 decimals, LF). */
export function writeCube(size: number, data: ArrayLike<number>, title?: string): string {
  const lines: string[] = []
  if (title) lines.push(`TITLE "${title.replace(/"/g, "'")}"`)
  lines.push(`LUT_3D_SIZE ${size}`)
  for (let i = 0; i < data.length; i += 3) {
    lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Tetrahedral interpolation in a 3D table of `size` points per side, input
 * already in grid units (0..size−1). The same arithmetic, case for case, as
 * ffmpeg's `lut3d` (`interp_tetrahedral`, vf_lut3d.c) and the preview's shader
 * (components/preview/gradeGl.ts) — checked within 1 level of `lut3d` on every
 * 24-bit colour (FFMPEG-NOTES "Colour table").
 */
export function tetrahedral(
  data: ArrayLike<number>,
  size: number,
  x: number,
  y: number,
  z: number,
  out: number[] = [0, 0, 0]
): number[] {
  const s = size - 1
  const pr = Math.min(Math.max(Math.floor(x), 0), s)
  const pg = Math.min(Math.max(Math.floor(y), 0), s)
  const pb = Math.min(Math.max(Math.floor(z), 0), s)
  const nr = Math.min(pr + 1, s)
  const ng = Math.min(pg + 1, s)
  const nb = Math.min(pb + 1, s)
  const dr = x - pr
  const dg = y - pg
  const db = z - pb
  // Entry offsets (red fastest): r · 3, g · size · 3, b · size² · 3.
  const R0 = pr * 3
  const R1 = nr * 3
  const G0 = pg * size * 3
  const G1 = ng * size * 3
  const B0 = pb * size * size * 3
  const B1 = nb * size * size * 3
  const c000 = R0 + G0 + B0
  const c111 = R1 + G1 + B1
  let a: number, b: number, w0: number, w1: number, w2: number, w3: number
  if (dr > dg) {
    if (dg > db) {
      a = R1 + G0 + B0
      b = R1 + G1 + B0
      w0 = 1 - dr
      w1 = dr - dg
      w2 = dg - db
      w3 = db
    } else if (dr > db) {
      a = R1 + G0 + B0
      b = R1 + G0 + B1
      w0 = 1 - dr
      w1 = dr - db
      w2 = db - dg
      w3 = dg
    } else {
      a = R0 + G0 + B1
      b = R1 + G0 + B1
      w0 = 1 - db
      w1 = db - dr
      w2 = dr - dg
      w3 = dg
    }
  } else if (db > dg) {
    a = R0 + G0 + B1
    b = R0 + G1 + B1
    w0 = 1 - db
    w1 = db - dg
    w2 = dg - dr
    w3 = dr
  } else if (db > dr) {
    a = R0 + G1 + B0
    b = R0 + G1 + B1
    w0 = 1 - dg
    w1 = dg - db
    w2 = db - dr
    w3 = dr
  } else {
    a = R0 + G1 + B0
    b = R1 + G1 + B0
    w0 = 1 - dg
    w1 = dg - dr
    w2 = dr - db
    w3 = db
  }
  for (let k = 0; k < 3; k++) out[k] = w0 * data[c000 + k] + w1 * data[a + k] + w2 * data[b + k] + w3 * data[c111 + k]
  return out
}

/**
 * A user's table applied to one colour (0..1 RGB, as the clip's values are
 * when the table comes in): the input mapped through its domain onto the grid
 * (clamped to it, like `lut3d`), tetrahedral for a 3D table and linear per
 * channel for a 1D one. The result is NOT clamped — the bake clamps once, at
 * the end.
 */
export function sampleCube(t: CubeTable, rgb: readonly number[], out: number[] = [0, 0, 0]): number[] {
  const s = t.size - 1
  const { domainMin: lo, domainMax: hi } = t
  const x = clamp01((rgb[0] - lo[0]) / (hi[0] - lo[0])) * s
  const y = clamp01((rgb[1] - lo[1]) / (hi[1] - lo[1])) * s
  const z = clamp01((rgb[2] - lo[2]) / (hi[2] - lo[2])) * s
  if (t.kind === '3d') return tetrahedral(t.data, t.size, x, y, z, out)
  const g = [x, y, z]
  for (let c = 0; c < 3; c++) {
    const i = Math.min(Math.floor(g[c]), s - 1)
    const f = g[c] - i
    out[c] = t.data[i * 3 + c] * (1 - f) + t.data[(i + 1) * 3 + c] * f
  }
  return out
}
