import { useRef, type JSX } from 'react'
import type { Project, ScriptLine } from '@shared/project'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'

const EMPTY_SCRIPT: ScriptLine[] = []

const fmt = (s: number): string => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** One script line: live-edited text, a pin-to-playhead time chip (click to seek). */
function ScriptLineRow({ line }: { line: ScriptLine }): JSX.Element {
  const update = useProject((s) => s.updateScriptLine)
  const remove = useProject((s) => s.removeScriptLine)
  const before = useRef<Project | null>(null)

  const seek = (): void => {
    if (line.atSec != null) {
      usePlayback.getState().setPlaying(false)
      usePlayback.getState().setTime(line.atSec)
    }
  }

  return (
    <div className="group flex items-start gap-1.5">
      <button
        onClick={() => (line.atSec == null ? update(line.id, { atSec: usePlayback.getState().time }) : seek())}
        title={line.atSec == null ? 'Pin to playhead' : 'Jump to this time'}
        className={`mt-1 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
          line.atSec == null
            ? 'bg-white/5 text-zinc-500 hover:bg-white/10'
            : 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/30'
        }`}
      >
        {line.atSec == null ? '◎' : fmt(line.atSec)}
      </button>
      <textarea
        value={line.text}
        rows={1}
        placeholder="Script line / talking point…"
        onFocus={() => (before.current = useProject.getState().project)}
        onChange={(e) =>
          // Root-scoped: the script lives on the Project, not the active comp.
          useProject.getState().liveUpdateRoot((p) => ({
            ...p,
            script: p.script.map((l) => (l.id === line.id ? { ...l, text: e.target.value } : l))
          }))
        }
        onBlur={() => before.current && useProject.getState().commitLive(before.current)}
        className="min-h-[28px] flex-1 resize-y rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-400/60"
      />
      <button
        onClick={() => remove(line.id)}
        className="mt-1 shrink-0 px-1 text-zinc-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
        title="Remove line"
      >
        ×
      </button>
    </div>
  )
}

/** Right-side script drawer. Non-modal so the timeline stays interactive. */
export function ScriptModal(): JSX.Element | null {
  const open = useUi((s) => s.scriptOpen)
  const setOpen = useUi((s) => s.setScriptOpen)
  const project = useProject((s) => s.project)
  const script = project?.script ?? EMPTY_SCRIPT
  const addLine = useProject((s) => s.addScriptLine)
  if (!open) return null

  return (
    <div className="absolute right-0 top-0 z-40 flex h-full w-[340px] flex-col border-l border-white/10 bg-zinc-900/95 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-100">Script</span>
        <button
          onClick={() => setOpen(false)}
          className="rounded px-2 py-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {script.length === 0 && (
          <p className="text-xs text-zinc-600">
            Jot down talking points. Pin a line to the playhead (◎) to jump back to that moment.
          </p>
        )}
        {script.map((line) => (
          <ScriptLineRow key={line.id} line={line} />
        ))}
      </div>
      <div className="border-t border-white/10 p-3">
        <button
          onClick={() => addLine(usePlayback.getState().time)}
          className="w-full rounded bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20"
        >
          ＋ Add line at playhead
        </button>
      </div>
    </div>
  )
}
