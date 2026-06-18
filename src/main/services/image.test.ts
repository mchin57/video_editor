import { describe, it, expect } from 'vitest'
import { buildDisplayImageArgs, DISPLAY_IMAGE_MAX_EDGE } from './image'

describe('buildDisplayImageArgs', () => {
  it('caps the longest edge without upscaling and emits an rgba PNG', () => {
    const args = buildDisplayImageArgs('in.heic', 'out.png')
    const s = args.join(' ')
    expect(s).toContain(`min(iw,${DISPLAY_IMAGE_MAX_EDGE})`)
    expect(s).toContain(`min(ih,${DISPLAY_IMAGE_MAX_EDGE})`)
    expect(s).toContain('force_original_aspect_ratio=decrease')
    expect(s).toContain('-c:v png')
    expect(s).toContain('-pix_fmt rgba') // preserve transparency for overlays
    expect(s).toContain('-frames:v 1')
    expect(args[args.length - 1]).toBe('out.png')
  })
})
