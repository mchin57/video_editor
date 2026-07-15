import { create } from 'zustand'
import type { DockviewApi } from 'dockview-react'
import { DOCK_PANELS, addPanelArgs, buildDefaultLayout, panelSpec, saveDockLayout } from '@/lib/dockLayout'

interface DockState {
  /** Set by Dock.tsx onReady; null until the dock mounts. */
  api: DockviewApi | null
  /** Which manifest panels are currently open (drives the View menu). */
  openPanels: Record<string, boolean>
  setApi: (api: DockviewApi) => void
  syncOpenPanels: () => void
  openPanel: (id: string) => void
  closePanel: (id: string) => void
  resetLayout: () => void
}

export const useDock = create<DockState>((set, get) => ({
  api: null,
  openPanels: {},

  setApi: (api) => {
    set({ api })
    get().syncOpenPanels()
  },

  syncOpenPanels: () => {
    const api = get().api
    if (!api) return
    const open = new Set(api.panels.map((p) => p.id))
    set({ openPanels: Object.fromEntries(DOCK_PANELS.map((p) => [p.id, open.has(p.id)])) })
  },

  openPanel: (id) => {
    const { api, openPanels } = get()
    const spec = panelSpec(id)
    if (!api || !spec || openPanels[id]) return
    api.addPanel(addPanelArgs(spec, (ref) => Boolean(openPanels[ref])))
  },

  closePanel: (id) => {
    const api = get().api
    const panel = api?.getPanel(id)
    if (panel) api!.removePanel(panel)
  },

  resetLayout: () => {
    const api = get().api
    if (!api) return
    api.clear()
    buildDefaultLayout(api)
    saveDockLayout(api.toJSON())
  }
}))
