import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/settings'
import { useUi } from '@/state/ui'
import { chooseExportDir, getSettings } from '@/ipc/client'

/** Settings modal. Currently: the default export folder the Save dialog opens to. */
export function SettingsModal(): JSX.Element | null {
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    if (open) void getSettings().then(setSettings)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8">
      <div className="w-[460px] rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 py-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Default export folder
        </div>
        <div className="flex items-center gap-2">
          <div
            className="min-w-0 flex-1 truncate rounded border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-zinc-300"
            title={settings?.exportDir}
          >
            {settings?.exportDir ?? '…'}
          </div>
          <button
            onClick={() => void chooseExportDir().then(setSettings)}
            className="shrink-0 rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
          >
            Change…
          </button>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          Each export still opens a Save dialog — this is just where it starts.
        </p>

        <div className="mt-5 flex justify-end">
          <button
            onClick={() => setOpen(false)}
            className="rounded-md bg-sky-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
