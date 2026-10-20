/** Timeline ▸ the transport / edit toolbar: play, time, the selection's link /
 *  split / snap / delete, add text or caption, follow mode, zoom, undo / redo. */

import type { JSX } from 'react'
import { clamp } from '@shared/math'
import { CompBreadcrumb } from '@/components/CompBreadcrumb'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { FOLLOW_OPTIONS, type FollowMode } from './constants'
import { tc } from './geometry'
import { ToolbarButton } from './parts'

/** An action on the selection, and whether it can run now. */
interface SelectionAction {
  run: () => void
  enabled: boolean
}

export function TimelineToolbar({
  canPlay,
  durationSec,
  link,
  unlink,
  split,
  snapToPrevious,
  remove,
  addText,
  addCaption,
  followMode,
  setFollowMode,
  setPxPerSec
}: {
  canPlay: boolean
  /** What the time readout counts up to. */
  durationSec: number
  link: SelectionAction
  unlink: SelectionAction
  split: SelectionAction
  snapToPrevious: SelectionAction
  remove: SelectionAction
  addText: () => void
  addCaption: () => void
  followMode: FollowMode
  setFollowMode: (mode: FollowMode) => void
  setPxPerSec: (next: (p: number) => number) => void
}): JSX.Element {
  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)
  const togglePlay = usePlayback((s) => s.toggle)
  const canUndo = useProject((s) => s.past.length > 0)
  const canRedo = useProject((s) => s.future.length > 0)
  const undo = useProject((s) => s.undo)
  const redo = useProject((s) => s.redo)

  return (
    <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
      <CompBreadcrumb />
      <button
        onClick={togglePlay}
        disabled={!canPlay}
        className="rounded bg-white/10 px-2 py-1 text-xs font-medium text-zinc-100 hover:bg-white/20 disabled:opacity-30"
        title={playing ? 'Pause (space)' : 'Play (space)'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="ml-1 w-24 font-mono text-[11px] text-zinc-400">
        {tc(time)} / {tc(durationSec)}
      </span>
      <div className="mx-1 h-4 w-px bg-white/10" />
      <ToolbarButton
        title="Link the selected tiles so they move, split and delete together (Ctrl/Cmd-click tiles to multi-select). Layouts can't be linked."
        onClick={link.run}
        disabled={!link.enabled}
      >
        🔗 Link
      </ToolbarButton>
      <ToolbarButton
        title="Unlink the selected tiles — the whole group they belong to"
        onClick={unlink.run}
        disabled={!unlink.enabled}
      >
        ⛓ Unlink
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-white/10" />
      <ToolbarButton
        title="Split the selection at the playhead (S) — every linked tile the playhead crosses"
        onClick={split.run}
        disabled={!split.enabled}
      >
        ✂ Split
      </ToolbarButton>
      <ToolbarButton
        title="Butt the selection against the previous clip in its lane, closing the gap (N). With nothing before it, snaps to the start."
        onClick={snapToPrevious.run}
        disabled={!snapToPrevious.enabled}
      >
        ⇤ Snap
      </ToolbarButton>
      <ToolbarButton title="Add a text layer at the playhead (T)" onClick={addText}>
        ＋ Text
      </ToolbarButton>
      <ToolbarButton
        title="Add a caption at the playhead, in the caption style (turns the caption lane on)"
        onClick={addCaption}
      >
        ＋ Caption
      </ToolbarButton>
      <ToolbarButton
        title="Delete the selection — every selected tile (Del)"
        onClick={remove.run}
        disabled={!remove.enabled}
      >
        🗑 Delete
      </ToolbarButton>
      <div className="flex-1" />
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">Follow</span>
      <div
        className="flex overflow-hidden rounded border border-white/10"
        role="group"
        aria-label="Playhead follow mode"
      >
        {FOLLOW_OPTIONS.map((o) => (
          <button
            key={o.mode}
            onClick={() => setFollowMode(o.mode)}
            title={o.title}
            className={`px-1.5 py-0.5 text-[10px] ${
              followMode === o.mode ? 'bg-white/20 text-zinc-100' : 'text-zinc-400 hover:bg-white/10'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="mx-1 h-4 w-px bg-white/10" />
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">Zoom</span>
      <ToolbarButton title="Zoom out" onClick={() => setPxPerSec((p) => clamp(p / 1.3, 8, 240))}>
        −
      </ToolbarButton>
      <ToolbarButton title="Zoom in" onClick={() => setPxPerSec((p) => clamp(p * 1.3, 8, 240))}>
        ＋
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-white/10" />
      <ToolbarButton title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        ↶ Undo
      </ToolbarButton>
      <ToolbarButton title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        ↷ Redo
      </ToolbarButton>
    </div>
  )
}
