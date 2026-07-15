/** Panel manifest + layout persistence for the dockable panel system.
 *
 *  Adding a panel is drop-in: add a PanelSpec here and register its content
 *  component in Dock.tsx — the View menu, default layout, reopen placement,
 *  and persistence all derive from this manifest (see docs/SHARED.md).
 */

export type DockDirection = 'left' | 'right' | 'above' | 'below' | 'within'

export interface PanelPlacement {
  /** Omit both fields to land in the active/default group. A direction with
   *  no referencePanel docks against the container edge. */
  direction?: DockDirection
  referencePanel?: string
  initialWidth?: number
  initialHeight?: number
}

export interface PanelSpec {
  id: string
  title: string
  defaultPlacement: PanelPlacement
}

/** Order matters: buildDefaultLayout adds panels in sequence, so a
 *  referencePanel must appear earlier in the list than its dependents. */
export const DOCK_PANELS: PanelSpec[] = [
  { id: 'preview', title: 'Preview', defaultPlacement: {} },
  {
    id: 'library',
    title: 'Library',
    defaultPlacement: { direction: 'left', referencePanel: 'preview', initialWidth: 256 }
  },
  {
    id: 'layers',
    title: 'Layers',
    defaultPlacement: { direction: 'right', referencePanel: 'preview', initialWidth: 256 }
  },
  {
    id: 'inspector',
    title: 'Inspector',
    defaultPlacement: { direction: 'below', referencePanel: 'layers', initialHeight: 360 }
  },
  // No referencePanel: docks against the container's bottom edge, spanning
  // the full width like the old fixed timeline row.
  { id: 'timeline', title: 'Timeline', defaultPlacement: { direction: 'below', initialHeight: 176 } }
]

export const panelSpec = (id: string): PanelSpec | undefined => DOCK_PANELS.find((p) => p.id === id)

/** Near-zero so panels are resizable "without limit" (dockview's group default
 *  is 100×100). */
export const PANEL_MIN_PX = 40

/** Mirrors dockview's AddPanelPositionOptions: anchored to an open panel, or
 *  to a container edge. */
export type DockPlacement =
  | { direction?: DockDirection; referencePanel: string }
  | { direction: Exclude<DockDirection, 'within'> }

interface AddPanelArgs {
  id: string
  component: string
  title: string
  position?: DockPlacement
  initialWidth?: number
  initialHeight?: number
  minimumWidth?: number
  minimumHeight?: number
}

/** Structural subset of DockviewApi so this module (and its tests) never
 *  touch the real dockview runtime. */
export interface DockAddPanelApi {
  addPanel(options: AddPanelArgs): unknown
}

/** Where to (re)open a panel: its default placement, dropping the
 *  referencePanel when that panel isn't currently open (falls back to the
 *  container edge, or the default group when there's no direction). */
export function placementFor(spec: PanelSpec, isOpen: (id: string) => boolean): DockPlacement | undefined {
  const { direction, referencePanel } = spec.defaultPlacement
  if (referencePanel && isOpen(referencePanel)) return { direction, referencePanel }
  if (direction && direction !== 'within') return { direction }
  return undefined
}

export function addPanelArgs(spec: PanelSpec, isOpen: (id: string) => boolean): AddPanelArgs {
  return {
    id: spec.id,
    component: spec.id,
    title: spec.title,
    position: placementFor(spec, isOpen),
    initialWidth: spec.defaultPlacement.initialWidth,
    initialHeight: spec.defaultPlacement.initialHeight,
    minimumWidth: PANEL_MIN_PX,
    minimumHeight: PANEL_MIN_PX
  }
}

export function buildDefaultLayout(api: DockAddPanelApi, panels: PanelSpec[] = DOCK_PANELS): void {
  const added = new Set<string>()
  for (const spec of panels) {
    // Panels earlier in the manifest are the only valid references. NOTE: do
    // not pass dockview's `inactive` here — a panel added inactive into a NEW
    // group leaves that group with no active tab, which renders the watermark
    // instead of the panel content.
    api.addPanel(addPanelArgs(spec, (id) => added.has(id)))
    added.add(spec.id)
  }
}

// ---------------------------------------------------------------------------
// Persistence: versioned envelopes in localStorage, repo-convention try/catch.
//
// Two layouts, same shape:
//   dockLayout        — the live session arrangement, saved on every change.
//   dockDefaultLayout — the user's own "default", captured via View ▸ Set
//                       default layout. Reset restores it; absent it, the
//                       built-in buildDefaultLayout arrangement is used.

export const DOCK_LAYOUT_KEY = 'dockLayout'
export const DOCK_DEFAULT_LAYOUT_KEY = 'dockDefaultLayout'
export const DOCK_LAYOUT_VERSION = 1

/** Shape-checked subset of dockview's SerializedDockview. */
interface SavedLayout {
  panels?: Record<string, unknown>
}

/** Returns the layout under `key`, or null when absent/corrupt/stale (wrong
 *  version, or referencing a panel id no longer in the manifest — callers
 *  fall back to the built-in layout rather than crash on restore). */
function readLayout(key: string, panels: PanelSpec[]): object | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const envelope = JSON.parse(raw)
    if (envelope?.v !== DOCK_LAYOUT_VERSION) return null
    const layout = envelope.layout as SavedLayout | null
    if (!layout || typeof layout !== 'object') return null
    const known = new Set(panels.map((p) => p.id))
    for (const id of Object.keys(layout.panels ?? {})) {
      if (!known.has(id)) return null
    }
    return layout
  } catch {
    return null
  }
}

function writeLayout(key: string, layout: object): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: DOCK_LAYOUT_VERSION, layout }))
  } catch {
    // best-effort, like the other localStorage persistence in this app
  }
}

/** The live session layout. Also retires the pre-dock 'panelSizes' key. */
export function loadDockLayout(panels: PanelSpec[] = DOCK_PANELS): object | null {
  try {
    localStorage.removeItem('panelSizes')
  } catch {
    // ignore
  }
  return readLayout(DOCK_LAYOUT_KEY, panels)
}

export function saveDockLayout(layout: object): void {
  writeLayout(DOCK_LAYOUT_KEY, layout)
}

/** The user's saved default arrangement, or null if they never set one. */
export function loadDefaultLayout(panels: PanelSpec[] = DOCK_PANELS): object | null {
  return readLayout(DOCK_DEFAULT_LAYOUT_KEY, panels)
}

export function saveDefaultLayout(layout: object): void {
  writeLayout(DOCK_DEFAULT_LAYOUT_KEY, layout)
}

/** Forget the user's default; Reset then goes back to the built-in layout. */
export function clearDefaultLayout(): void {
  try {
    localStorage.removeItem(DOCK_DEFAULT_LAYOUT_KEY)
  } catch {
    // ignore
  }
}
