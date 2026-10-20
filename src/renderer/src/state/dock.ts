import { create } from 'zustand'
import type { DockviewApi } from 'dockview-react'
import {
  DOCK_PANELS,
  addPanelArgs,
  buildDefaultLayout,
  clearDefaultLayout,
  loadDefaultLayout,
  panelSpec,
  saveDefaultLayout,
  saveDockLayout
} from '@/lib/dockLayout'
import { createLogger } from '@shared/log'

const log = createLogger('dock')

/** Restore `layout`, falling back to the built-in arrangement when it's absent
 *  or dockview rejects it. The single restore path — startup and Reset both
 *  come through here. */
export function applyLayout(api: DockviewApi, layout: object | null): void {
  if (layout) {
    try {
      api.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0])
      return
    } catch (error) {
      log.warn('saved panel layout is unreadable; using the built-in one', error)
      // corrupt/incompatible — fall through to the built-in layout
    }
  }
  api.clear()
  buildDefaultLayout(api)
}

interface DockState {
  /** Set by Dock.tsx onReady; null until the dock mounts. */
  api: DockviewApi | null
  /** Which manifest panels are currently open (drives the View menu). */
  openPanels: Record<string, boolean>
  /** True once the user has saved their own default via the View menu. */
  hasCustomDefault: boolean
  setApi: (api: DockviewApi) => void
  syncOpenPanels: () => void
  openPanel: (id: string) => void
  closePanel: (id: string) => void
  /** Capture the current arrangement as the user's default. */
  setDefaultLayout: () => void
  /** Forget the saved default; Reset returns to the built-in layout. */
  clearDefault: () => void
  /** Restore the user's default, or the built-in layout if they have none. */
  resetLayout: () => void
}

export const useDock = create<DockState>((set, get) => ({
  api: null,
  openPanels: {},
  hasCustomDefault: loadDefaultLayout() !== null,

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

  setDefaultLayout: () => {
    const api = get().api
    if (!api) return
    saveDefaultLayout(api.toJSON())
    set({ hasCustomDefault: true })
  },

  clearDefault: () => {
    clearDefaultLayout()
    set({ hasCustomDefault: false })
  },

  resetLayout: () => {
    const api = get().api
    if (!api) return
    applyLayout(api, loadDefaultLayout())
    saveDockLayout(api.toJSON())
  }
}))
