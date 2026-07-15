import type { JSX } from 'react'
import {
  DockviewReact,
  themeAbyss,
  type DockviewReadyEvent,
  type IDockviewPanelProps
} from 'dockview-react'
import { DockPanel } from '@/components/DockPanel'
import { Library } from '@/components/Library'
import { PreviewStage } from '@/components/PreviewStage'
import { LayersPanel } from '@/components/LayersPanel'
import { Inspector } from '@/components/Inspector'
import { Timeline } from '@/components/Timeline'
import { buildDefaultLayout, loadDockLayout, saveDockLayout } from '@/lib/dockLayout'
import { useDock } from '@/state/dock'

/** 9:16 stage fitted inside the panel regardless of its shape (PreviewStage's
 *  own root is height-driven `aspect-[9/16] h-full`, which would overflow a
 *  narrow panel). 24px = 12px breathing room per side. */
function PreviewPanel(): JSX.Element {
  return (
    <DockPanel>
      <div className="flex h-full items-center justify-center" style={{ containerType: 'size' }}>
        <div style={{ height: 'min(100cqh - 24px, calc((100cqw - 24px) * 16 / 9))' }}>
          <PreviewStage />
        </div>
      </div>
    </DockPanel>
  )
}

/** Content renderers keyed by manifest panel id. Adding a panel = one entry
 *  here + one PanelSpec in lib/dockLayout.ts (a vitest check keeps the two in
 *  sync). Module-level so identities are stable across renders. */
export const DOCK_COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  preview: PreviewPanel,
  library: () => (
    <DockPanel>
      <Library />
    </DockPanel>
  ),
  layers: () => (
    <DockPanel>
      <LayersPanel />
    </DockPanel>
  ),
  inspector: () => (
    <DockPanel>
      <Inspector />
    </DockPanel>
  ),
  timeline: () => (
    <DockPanel>
      <Timeline />
    </DockPanel>
  )
}

function Watermark(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-xs text-zinc-500">
      All panels closed — reopen them from the View menu
    </div>
  )
}

function onReady({ api }: DockviewReadyEvent): void {
  // StrictMode double-invokes onReady on the same instance in dev; only
  // build the layout once.
  if (api.panels.length === 0) {
    const saved = loadDockLayout()
    if (saved) {
      try {
        api.fromJSON(saved as Parameters<typeof api.fromJSON>[0])
      } catch {
        api.clear()
        buildDefaultLayout(api)
      }
    } else {
      buildDefaultLayout(api)
    }
  }

  // Subscribe after restore so the restore itself doesn't immediately
  // re-serialize; debounce because sash drags fire per-frame.
  let timer: ReturnType<typeof setTimeout> | undefined
  api.onDidLayoutChange(() => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        saveDockLayout(api.toJSON())
      } catch {
        // api disposed mid-debounce (window closing) — nothing to save
      }
    }, 300)
  })

  const sync = (): void => useDock.getState().syncOpenPanels()
  api.onDidAddPanel(sync)
  api.onDidRemovePanel(sync)
  useDock.getState().setApi(api)
}

export function Dock(): JSX.Element {
  return (
    <DockviewReact
      components={DOCK_COMPONENTS}
      watermarkComponent={Watermark}
      onReady={onReady}
      theme={themeAbyss}
      disableFloatingGroups
    />
  )
}
