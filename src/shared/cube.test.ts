import { describe, expect, it } from 'vitest'
import { CubeError, parseCube, sampleCube, tetrahedral, writeCube, type CubeTable } from './cube'

/** A `size`³ table of `fn` over the grid, red fastest. */
function grid(size: number, fn: (r: number, g: number, b: number) => number[]): number[] {
  const out: number[] = []
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) out.push(...fn(r / (size - 1), g / (size - 1), b / (size - 1)))
  return out
}

const cubeText = (size: number, data: number[], head = ''): string =>
  `${head}LUT_3D_SIZE ${size}\r\n` +
  Array.from({ length: data.length / 3 }, (_, i) => `${data[i * 3]} ${data[i * 3 + 1]} ${data[i * 3 + 2]}`).join('\r\n')

describe('parseCube', () => {
  it('reads a real-world 3D file: CRLF, a quoted TITLE, comments, blank lines and domain lines', () => {
    const data = grid(2, (r, g, b) => [r, g, b])
    const text =
      '#Copyright: someone\r\nTITLE "Kim Amland - Photographic 01"\r\n\r\n#LUT size\r\n' +
      cubeText(2, data, 'DOMAIN_MIN 0.0 0.0 0.0\r\nDOMAIN_MAX 1.0 1.0 1.0\r\n\r\n')
    const t = parseCube(text)
    expect(t.kind).toBe('3d')
    expect(t.size).toBe(2)
    expect(t.title).toBe('Kim Amland - Photographic 01')
    expect(Array.from(t.data)).toEqual(data)
    expect(t.domainMin).toEqual([0, 0, 0])
    expect(t.domainMax).toEqual([1, 1, 1])
  })

  it('ignores a UTF-8 byte-order mark and lowercase keywords', () => {
    const t = parseCube(
      '﻿lut_3d_size 2\n' +
        cubeText(
          2,
          grid(2, (r, g, b) => [r, g, b])
        )
          .split('\r\n')
          .slice(1)
          .join('\n')
    )
    expect(t.size).toBe(2)
  })

  it('reads a 1D table and Resolve’s LUT_3D_INPUT_RANGE spelling of a domain', () => {
    const one = parseCube('LUT_1D_SIZE 3\n0 0 0\n0.25 0.5 0.75\n1 1 1\n')
    expect(one.kind).toBe('1d')
    expect(one.size).toBe(3)
    const ranged = parseCube(
      cubeText(
        2,
        grid(2, (r, g, b) => [r, g, b]),
        'LUT_3D_INPUT_RANGE 0 2\n'
      )
    )
    expect(ranged.domainMax).toEqual([2, 2, 2])
  })

  it('takes slightly negative and "-0.0000" values as written (the bake clamps later)', () => {
    const data = grid(2, (r, g, b) => [r, g, b])
    data[3] = -0.0003
    const t = parseCube(cubeText(2, data).replace(/^0 0 0/m, '-0.0000 -0.0000 -0.0000'))
    expect(t.data[3]).toBeCloseTo(-0.0003, 6)
    expect(t.data[0]).toBe(-0)
  })

  it.each([
    ['empty file', '', /no LUT_3D_SIZE/],
    ['no size line', '0 0 0\n1 1 1\n', /no LUT_3D_SIZE/],
    ['a size out of range', 'LUT_3D_SIZE 1\n0 0 0\n', /size must be/],
    ['a size too large', 'LUT_3D_SIZE 300\n', /size must be/],
    ['a non-integer size', 'LUT_3D_SIZE 2.5\n', /size must be/],
    ['too few entries', 'LUT_3D_SIZE 2\n0 0 0\n1 1 1\n', /should have 8 entries .* but has 2/],
    [
      'too many entries',
      cubeText(
        2,
        grid(2, (r, g, b) => [r, g, b])
      ) + '\n0 0 0',
      /but has 9/
    ],
    ['a word in the data', 'LUT_3D_SIZE 2\n0 0 x\n', /Line 2: A table entry needs three numbers/],
    ['two numbers on a line', 'LUT_3D_SIZE 2\n0 0\n', /three numbers/],
    ['both 1D and 3D', 'LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n', /both a 1D and a 3D/],
    [
      'an empty domain',
      'DOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n' +
        cubeText(
          2,
          grid(2, (r, g, b) => [r, g, b])
        ),
      /DOMAIN_MAX/
    ],
    [
      'a keyword after the data',
      cubeText(
        2,
        grid(2, (r, g, b) => [r, g, b])
      ) + '\nTITLE "late"',
      /after the table data/
    ],
    ['a binary file', '\u0000\u0001\u0002PNG', /three numbers/]
  ])('refuses %s with a reason', (_, text, reason) => {
    expect(() => parseCube(text)).toThrow(CubeError)
    expect(() => parseCube(text)).toThrow(reason)
  })
})

describe('writeCube', () => {
  it('round-trips through parseCube to 6 places', () => {
    const data = grid(5, (r, g, b) => [r * 0.9 + 0.0123456789, g * g, Math.sqrt(b)])
    const text = writeCube(5, data, 'Baked "look"')
    expect(text.startsWith('TITLE "Baked \'look\'"\nLUT_3D_SIZE 5\n')).toBe(true)
    const back = parseCube(text)
    expect(back.size).toBe(5)
    expect(back.title).toBe("Baked 'look'")
    data.forEach((v, i) => expect(back.data[i]).toBeCloseTo(v, 6))
  })
})

describe('tetrahedral / sampleCube', () => {
  const identity = (size: number): CubeTable => ({
    kind: '3d',
    size,
    data: Float32Array.from(grid(size, (r, g, b) => [r, g, b])),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1]
  })

  it('an identity table returns the colour it was given', () => {
    for (const size of [2, 17, 33, 65]) {
      const t = identity(size)
      for (const rgb of [
        [0, 0, 0],
        [1, 1, 1],
        [0.2, 0.7, 0.4],
        [0.91, 0.13, 0.55],
        [0.5, 0.5, 0.5]
      ]) {
        sampleCube(t, rgb).forEach((v, k) => expect(v).toBeCloseTo(rgb[k], 5))
      }
    }
  })

  it('is exact at grid points and linear along an edge', () => {
    const t = Float32Array.from(grid(3, (r, g, b) => [r * r, g, b * 0.5]))
    expect(tetrahedral(t, 3, 1, 2, 0)).toEqual([0.25, 1, 0])
    // Halfway between red 0.5 (0.25) and red 1 (1): 0.625.
    expect(tetrahedral(t, 3, 1.5, 0, 0)[0]).toBeCloseTo(0.625, 6)
  })

  it('maps the input through DOMAIN_MIN / DOMAIN_MAX and clamps outside it', () => {
    const t: CubeTable = { ...identity(2), domainMin: [0, 0, 0], domainMax: [2, 2, 2] }
    expect(sampleCube(t, [1, 0.5, 0])).toEqual([0.5, 0.25, 0])
    expect(sampleCube(t, [3, -1, 0])).toEqual([1, 0, 0])
  })

  it('a 1D table is one linear curve per channel', () => {
    const t = parseCube('LUT_1D_SIZE 3\n0 0 1\n0.25 0.5 0.5\n1 1 0\n')
    const out = sampleCube(t, [0.25, 0.5, 1])
    expect(out[0]).toBeCloseTo(0.125, 6)
    expect(out[1]).toBeCloseTo(0.5, 6)
    expect(out[2]).toBeCloseTo(0, 6)
  })
})
