import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/settings'
import { mcpAddCommand } from '@shared/settings'
import type { AssistantStatus } from '@shared/assistant/protocol'
import { useUi } from '@/state/ui'
import { assistantStatus, chooseExportDir, getSettings, updateSettings } from '@/ipc/client'
import { btnCls, Check } from './ui'

/** Settings modal. Currently: the default export folder the Save dialog opens to. */
export function SettingsModal(): JSX.Element | null {
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const [settings, setSettings] = useState<Settings | null>(null)

  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const refreshStatus = (): void => void assistantStatus().then(setStatus)

  useEffect(() => {
    if (!open) return
    void getSettings().then(setSettings)
    refreshStatus()
    setCopied(false)
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
          The Export button opens a Save dialog starting here; assistant exports save here directly.
        </p>

        <div className="mt-5 mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Niche keyword bank (one per line)
        </div>
        <textarea
          value={(settings?.keywordBank ?? []).join('\n')}
          onChange={(e) => {
            const keywordBank = e.target.value.split('\n').map((k) => k.trim())
            setSettings((s) => (s ? { ...s, keywordBank } : s))
          }}
          onBlur={() =>
            settings &&
            void updateSettings({
              keywordBank: settings.keywordBank.map((k) => k.trim()).filter(Boolean)
            })
          }
          rows={6}
          className="w-full rounded border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-400/60"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          The checklist scores your captions against these for spoken-keyword reach.
        </p>

        <div className="mt-5 mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
          AI assistant (Claude Code)
        </div>
        <Check
          checked={settings?.assistant.enabled ?? false}
          onChange={(enabled) => {
            if (!settings) return
            void updateSettings({ assistant: { ...settings.assistant, enabled } }).then((s) => {
              setSettings(s)
              refreshStatus()
            })
          }}
        >
          Let Claude Code control the editor
        </Check>
        <p data-testid="assistant-status" className="text-[11px] text-zinc-500">
          {status === null
            ? '…'
            : status.state === 'listening'
              ? 'Listening for Claude Code'
              : status.state === 'off'
                ? 'Off'
                : status.message}
        </p>
        {settings?.assistant.enabled && status && (
          <>
            <p className="mt-2 text-[11px] text-zinc-400">
              Register once in a terminal — then every Claude Code session can use the editor while it is open:
            </p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[10px] text-zinc-300">
                {mcpAddCommand(status.scriptPath)}
              </code>
              <button
                className={btnCls}
                onClick={() => void navigator.clipboard.writeText(mcpAddCommand(status.scriptPath)).then(() => setCopied(true))}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Then run <code>/edit-video</code> in a Claude Code session opened in this repo.
            </p>
          </>
        )}

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
