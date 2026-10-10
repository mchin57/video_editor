// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTextLayer, makeVideoLayer } from '@shared/layers'
import { exportRefusal, sanitizeExportName, uniqueExportPath } from './exportTarget'

describe('sanitizeExportName', () => {
  it('forces .mp4 and keeps a plain name', () => {
    expect(sanitizeExportName('my cut')).toBe('my cut.mp4')
    expect(sanitizeExportName('my cut.MP4')).toBe('my cut.mp4')
  })

  it('drops any directory part so a name cannot leave the export folder', () => {
    expect(sanitizeExportName('../../evil.mp4')).toBe('evil.mp4')
    expect(sanitizeExportName('C:\\Windows\\x')).toBe('x.mp4')
  })

  it('strips reserved characters and trailing dots/spaces', () => {
    expect(sanitizeExportName('a<b>:c"d|e?f*. ')).toBe('abcdef.mp4')
  })

  it('rejects names that end up empty and guards device names', () => {
    expect(sanitizeExportName('..')).toBeNull()
    expect(sanitizeExportName('   ')).toBeNull()
    expect(sanitizeExportName('CON')).toBe('_CON.mp4')
  })
})

describe('uniqueExportPath', () => {
  it('keeps a free name and numbers collisions', () => {
    const taken = new Set([join('d', 'cut.mp4'), join('d', 'cut (2).mp4')])
    expect(uniqueExportPath('d', 'new.mp4', (p) => taken.has(p))).toBe(join('d', 'new.mp4'))
    expect(uniqueExportPath('d', 'cut.mp4', (p) => taken.has(p))).toBe(join('d', 'cut (3).mp4'))
  })
})

describe('exportRefusal', () => {
  const clip = makeVideoLayer('v', 'm', 0, 3)
  const text = makeTextLayer('t', 0, 2)

  it('allows a project with a video clip and no export running', () => {
    expect(exportRefusal({ layers: [clip] }, [{ type: 'export', status: 'done' }])).toBeNull()
  })

  it('refuses while another export is running', () => {
    expect(exportRefusal({ layers: [clip] }, [{ type: 'export', status: 'running' }])).toMatch(/already running/)
  })

  it('refuses a timeline with no video clips', () => {
    expect(exportRefusal({ layers: [text] }, [])).toMatch(/no video clips/)
  })
})
