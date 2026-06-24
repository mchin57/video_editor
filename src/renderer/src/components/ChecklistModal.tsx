import { useEffect, useMemo, useState, type JSX } from 'react'
import { audioClipEnd } from '@shared/project'
import { EXPORT_PRESETS } from '@shared/export'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { useLibrary } from '@/hooks/useMedia'
import { getSettings } from '@/ipc/client'
import { visualDuration } from '@shared/layers'
import { buildChecklist, type CheckStatus } from '@/lib/checklist'

const ICON: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' }
const COLOR: Record<CheckStatus, string> = {
  pass: 'text-emerald-400',
  warn: 'text-amber-400',
  fail: 'text-rose-400'
}

export function ChecklistModal(): JSX.Element | null {
  const open = useUi((s) => s.checklistOpen)
  const setOpen = useUi((s) => s.setChecklistOpen)
  const project = useProject((s) => s.project)
  const { data: assets = [] } = useLibrary()
  const [keywordBank, setKeywordBank] = useState<string[]>([])

  useEffect(() => {
    if (open) void getSettings().then((s) => setKeywordBank(s.keywordBank))
  }, [open])

  const result = useMemo(() => {
    if (!project) return null
    const assetDur = (id: string): number => assets.find((a) => a.id === id)?.probe.durationSec ?? 0
    const videoDur = visualDuration(project.layers)
    const audioDur = project.audioClips.reduce((m, a) => Math.max(m, audioClipEnd(a, assetDur(a.mediaId))), 0)
    const target = EXPORT_PRESETS[project.preset]
    const is916 = Math.abs(target.width / target.height - 9 / 16) < 0.01
    return buildChecklist(project, { durationSec: Math.max(videoDur, audioDur), keywordBank, is916 })
  }, [project, assets, keywordBank])

  if (!open || !result) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onClick={() => setOpen(false)}>
      <div
        className="w-[460px] max-w-full rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">Reel checklist</h2>
          <div className="flex items-center gap-2">
            <span
              className={`text-lg font-bold ${
                result.score >= 80 ? 'text-emerald-400' : result.score >= 50 ? 'text-amber-400' : 'text-rose-400'
              }`}
            >
              {result.score}
            </span>
            <span className="text-xs text-zinc-500">/ 100</span>
          </div>
        </div>

        <ul className="flex flex-col gap-2.5">
          {result.items.map((item) => (
            <li key={item.id} className="flex gap-2.5">
              <span className={`mt-0.5 text-sm ${COLOR[item.status]}`}>{ICON[item.status]}</span>
              <div className="min-w-0">
                <div className="text-xs font-medium text-zinc-200">{item.label}</div>
                <div className="text-[11px] text-zinc-500">{item.detail}</div>
              </div>
            </li>
          ))}
        </ul>

        <button
          onClick={() => setOpen(false)}
          className="mt-5 w-full rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          Close
        </button>
      </div>
    </div>
  )
}
