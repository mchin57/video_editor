import { describe, expect, it } from 'vitest'
import { DOCK_PANELS } from '@/lib/dockLayout'

describe('dock registry', () => {
  it('has exactly one content component per manifest panel', async () => {
    // The panel components transitively import ipc/client, which destructures
    // window.api at module load — stub it before pulling Dock in.
    ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => undefined })
    const { DOCK_COMPONENTS } = await import('./Dock')
    expect(Object.keys(DOCK_COMPONENTS).sort()).toEqual(DOCK_PANELS.map((p) => p.id).sort())
  })
})
