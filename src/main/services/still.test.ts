import { describe, it, expect } from 'vitest'
import { buildStillArgs } from './still'

describe('buildStillArgs', () => {
  it('seeks to the source time and grabs one frame', () => {
    const a = buildStillArgs('C:/v/a.mov', 'out.png', 4.25)
    expect(a.join(' ')).toContain('-ss 4.250 -i C:/v/a.mov -map 0:v:0 -frames:v 1')
    expect(a[a.length - 1]).toBe('out.png')
    expect(a).not.toContain('-vf') // no chain → no -vf
  })

  it('applies a -vf chain when given (e.g. tonemap + crop)', () => {
    const a = buildStillArgs('in.mov', 'o.png', 1, ['tonemapX', 'crop=600:1000:10:20']).join(' ')
    expect(a).toContain('-vf tonemapX,crop=600:1000:10:20')
  })

  it('adds a quality flag for jpg output only', () => {
    expect(buildStillArgs('i', 'o.jpg', 0).join(' ')).toContain('-q:v 2')
    expect(buildStillArgs('i', 'o.png', 0)).not.toContain('-q:v')
  })

  it('clamps negative seek to zero', () => {
    expect(buildStillArgs('i', 'o.png', -3).join(' ')).toContain('-ss 0.000')
  })
})
