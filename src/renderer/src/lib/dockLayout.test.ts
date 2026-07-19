import { beforeEach, describe, expect, it } from 'vitest'
import {
  DOCK_DEFAULT_LAYOUT_KEY,
  DOCK_LAYOUT_KEY,
  DOCK_LAYOUT_VERSION,
  DOCK_PANELS,
  PANEL_MIN_PX,
  buildDefaultLayout,
  clearDefaultLayout,
  loadDefaultLayout,
  loadDockLayout,
  placementFor,
  panelSpec,
  saveDefaultLayout,
  saveDockLayout,
  type DockAddPanelApi
} from './dockLayout'

const recordingApi = (): DockAddPanelApi & { calls: Parameters<DockAddPanelApi['addPanel']>[0][] } => {
  const calls: Parameters<DockAddPanelApi['addPanel']>[0][] = []
  return { calls, addPanel: (o) => calls.push(o) }
}

describe('manifest', () => {
  it('every referencePanel appears earlier in the manifest than its dependent', () => {
    const seen = new Set<string>()
    for (const spec of DOCK_PANELS) {
      const ref = spec.defaultPlacement.referencePanel
      if (ref) expect(seen.has(ref), `${spec.id} references ${ref}`).toBe(true)
      seen.add(spec.id)
    }
  })

  it('panelSpec looks up by id', () => {
    expect(panelSpec('timeline')?.title).toBe('Timeline')
    expect(panelSpec('nope')).toBeUndefined()
  })
})

describe('buildDefaultLayout', () => {
  it('adds every manifest panel in order with the default arrangement', () => {
    const api = recordingApi()
    buildDefaultLayout(api)
    expect(api.calls.map((c) => c.id)).toEqual(['preview', 'library', 'layers', 'inspector', 'format', 'timeline'])

    const byId = Object.fromEntries(api.calls.map((c) => [c.id, c]))
    expect(byId.preview.position).toBeUndefined()
    expect(byId.library.position).toEqual({ direction: 'left', referencePanel: 'preview' })
    expect(byId.library.initialWidth).toBe(256)
    expect(byId.layers.position).toEqual({ direction: 'right', referencePanel: 'preview' })
    expect(byId.inspector.position).toEqual({ direction: 'below', referencePanel: 'layers' })
    // Format tabs into the Inspector's group.
    expect(byId.format.position).toEqual({ direction: 'within', referencePanel: 'inspector' })
    // Timeline docks to the container edge (no reference) so it spans full width.
    expect(byId.timeline.position).toEqual({ direction: 'below' })
    expect(byId.timeline.initialHeight).toBe(176)
  })

  it('applies near-zero minimums; inactive only for within-group tabs (it blanks new groups)', () => {
    const api = recordingApi()
    buildDefaultLayout(api)
    for (const c of api.calls) {
      expect(c.minimumWidth).toBe(PANEL_MIN_PX)
      expect(c.minimumHeight).toBe(PANEL_MIN_PX)
      // `inactive` on a panel that creates a NEW group renders the watermark;
      // it's only safe (and wanted) when tabbing into an existing group, so
      // the group's reference panel stays the front tab.
      expect('inactive' in c && c.inactive).toBe(c.id === 'format')
    }
  })
})

describe('placementFor', () => {
  const spec = panelSpec('library')!

  it('uses the reference panel when it is open', () => {
    expect(placementFor(spec, (id) => id === 'preview')).toEqual({
      direction: 'left',
      referencePanel: 'preview'
    })
  })

  it('falls back to the container edge when the reference is closed', () => {
    expect(placementFor(spec, () => false)).toEqual({ direction: 'left' })
  })

  it('returns undefined (default group) when there is no usable direction', () => {
    expect(placementFor(panelSpec('preview')!, () => false)).toBeUndefined()
  })
})

describe('persistence', () => {
  beforeEach(() => localStorage.clear())

  const validLayout = { grid: {}, panels: { preview: {}, timeline: {} } }

  it('round-trips a layout through the versioned envelope', () => {
    saveDockLayout(validLayout)
    expect(loadDockLayout()).toEqual(validLayout)
    expect(JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY)!).v).toBe(DOCK_LAYOUT_VERSION)
  })

  it('returns null when nothing is saved', () => {
    expect(loadDockLayout()).toBeNull()
  })

  it('rejects corrupt JSON', () => {
    localStorage.setItem(DOCK_LAYOUT_KEY, '{not json')
    expect(loadDockLayout()).toBeNull()
  })

  it('rejects a stale version', () => {
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ v: 0, layout: validLayout }))
    expect(loadDockLayout()).toBeNull()
  })

  it('rejects a layout referencing a panel id not in the manifest', () => {
    saveDockLayout({ panels: { preview: {}, retired: {} } })
    expect(loadDockLayout()).toBeNull()
  })

  it('retires the legacy panelSizes key on load', () => {
    localStorage.setItem('panelSizes', '{"libW":256}')
    loadDockLayout()
    expect(localStorage.getItem('panelSizes')).toBeNull()
  })
})

describe('user default layout', () => {
  beforeEach(() => localStorage.clear())

  const layout = { grid: {}, panels: { preview: {}, timeline: {} } }

  it('is absent until one is saved, then round-trips', () => {
    expect(loadDefaultLayout()).toBeNull()
    saveDefaultLayout(layout)
    expect(loadDefaultLayout()).toEqual(layout)
    expect(JSON.parse(localStorage.getItem(DOCK_DEFAULT_LAYOUT_KEY)!).v).toBe(DOCK_LAYOUT_VERSION)
  })

  it('is stored separately from the live session layout', () => {
    saveDefaultLayout(layout)
    saveDockLayout({ grid: {}, panels: { preview: {} } })
    // Saving the session must not disturb the saved default.
    expect(loadDefaultLayout()).toEqual(layout)
  })

  it('clearing forgets it without touching the session layout', () => {
    saveDefaultLayout(layout)
    saveDockLayout(layout)
    clearDefaultLayout()
    expect(loadDefaultLayout()).toBeNull()
    expect(loadDockLayout()).toEqual(layout)
  })

  it('rejects a stale default referencing an unknown panel', () => {
    saveDefaultLayout({ panels: { preview: {}, retired: {} } })
    expect(loadDefaultLayout()).toBeNull()
  })
})
