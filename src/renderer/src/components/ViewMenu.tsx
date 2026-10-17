import { useEffect, useRef, useState, type JSX } from 'react'
import { DOCK_PANELS } from '@/lib/dockLayout'
import { useDock } from '@/state/dock'

function ActionItem({ label, title, onClick }: { label: string; title: string; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/10"
    >
      <span className="w-3" />
      <span>{label}</span>
    </button>
  )
}

/**
 * View menu: toggle each dockable panel (driven by the manifest in
 * lib/dockLayout.ts — new panels appear here automatically), save the current
 * arrangement as your default, and reset back to it. Dropdown mechanics
 * mirror FileMenu.
 */
export function ViewMenu(): JSX.Element {
  const openPanels = useDock((s) => s.openPanels)
  const hasCustomDefault = useDock((s) => s.hasCustomDefault)
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20"
      >
        View ▾
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border border-white/10 bg-zinc-900 p-1 shadow-2xl">
          {DOCK_PANELS.map((p) => {
            const isOpen = Boolean(openPanels[p.id])
            return (
              <button
                key={p.id}
                onClick={() => {
                  const dock = useDock.getState()
                  if (isOpen) dock.closePanel(p.id)
                  else dock.openPanel(p.id)
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/10"
              >
                <span className="w-3 text-sky-400">{isOpen ? '✓' : ''}</span>
                <span>{p.title}</span>
              </button>
            )
          })}
          <div className="my-1 h-px bg-white/10" />
          <ActionItem
            label={saved ? 'Default layout saved ✓' : 'Set default layout'}
            title="Save the current arrangement as your default — Reset layout restores it"
            onClick={() => {
              useDock.getState().setDefaultLayout()
              // Confirm in place: the menu stays open so it's obvious it took.
              setSaved(true)
              setTimeout(() => setSaved(false), 1200)
            }}
          />
          <ActionItem
            label="Reset layout"
            title={hasCustomDefault ? 'Restore your saved default layout' : 'Restore the built-in layout'}
            onClick={() => {
              setOpen(false)
              useDock.getState().resetLayout()
            }}
          />
          {hasCustomDefault && (
            <ActionItem
              label="Forget saved default"
              title="Discard your default; Reset layout goes back to the built-in arrangement"
              onClick={() => {
                setOpen(false)
                useDock.getState().clearDefault()
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
