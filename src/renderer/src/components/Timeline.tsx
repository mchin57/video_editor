import { useMemo, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { Clip } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { clipDuration, locate, timelineDuration } from '@/lib/timeline'
import { thumbUrl } from '@/ipc/client'

const PX_PER_SEC = 48
const HOOK_SEC = 3

// Stable empty reference (see PreviewStage note) to avoid re-render loops.
const EMPTY_CLIPS: Clip[] = []

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

function tc(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const rem = (s % 60).toFixed(1)
  return `${m}:${rem.padStart(4, '0')}`
}

function ToolbarButton({
  onClick,
  disabled,
  title,
  children
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

export function Timeline(): JSX.Element {
  const project = useProject((s) => s.project)
  const clips = project?.clips ?? EMPTY_CLIPS
  const selectedClipId = useProject((s) => s.selectedClipId)
  const selectClip = useProject((s) => s.selectClip)
  const removeClip = useProject((s) => s.removeClip)
  const reorderClips = useProject((s) => s.reorderClips)
  const splitClipAt = useProject((s) => s.splitClipAt)
  const toggleMute = useProject((s) => s.toggleMute)
  const canUndo = useProject((s) => s.past.length > 0)
  const canRedo = useProject((s) => s.future.length > 0)
  const undo = useProject((s) => s.undo)
  const redo = useProject((s) => s.redo)

  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)
  const togglePlay = usePlayback((s) => s.toggle)
  const setPlaying = usePlayback((s) => s.setPlaying)
  const setTime = usePlayback((s) => s.setTime)

  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const total = timelineDuration(clips)
  const trackInnerRef = useRef<HTMLDivElement>(null)

  const selectedIndex = clips.findIndex((c) => c.id === selectedClipId)

  const scrubToClientX = (clientX: number): void => {
    const inner = trackInnerRef.current
    if (!inner) return
    const x = clientX - inner.getBoundingClientRect().left
    setTime(clamp(x / PX_PER_SEC, 0, total))
  }

  // Scrub from a pointer-down anywhere on the track (clips included). Trim
  // handles stopPropagation so they aren't treated as scrubs.
  const onTrackDown = (e: ReactPointerEvent): void => {
    e.preventDefault()
    setPlaying(false)
    scrubToClientX(e.clientX)
    const onMove = (ev: PointerEvent): void => scrubToClientX(ev.clientX)
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startTrim = (
    e: ReactPointerEvent,
    clip: Clip,
    side: 'in' | 'out',
    maxOut: number
  ): void => {
    e.stopPropagation()
    e.preventDefault()
    setPlaying(false)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { inSec, outSec } = clip
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / PX_PER_SEC
      useProject.getState().liveUpdate((p) => ({
        ...p,
        clips: p.clips.map((c) => {
          if (c.id !== clip.id) return c
          if (side === 'in') return { ...c, inSec: clamp(inSec + d, 0, c.outSec - 0.1) }
          return { ...c, outSec: clamp(outSec + d, c.inSec + 0.1, maxOut) }
        })
      }))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      useProject.getState().commitLive(before)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const splitSelected = (): void => {
    if (selectedIndex < 0) return
    const p = locate(clips, time)
    if (p && p.index === selectedIndex) splitClipAt(clips[selectedIndex].id, p.localTime)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Transport / edit toolbar */}
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
        <button
          onClick={togglePlay}
          disabled={clips.length === 0}
          className="rounded bg-white/10 px-2 py-1 text-xs font-medium text-zinc-100 hover:bg-white/20 disabled:opacity-30"
          title={playing ? 'Pause (space)' : 'Play (space)'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="ml-1 w-24 font-mono text-[11px] text-zinc-400">
          {tc(time)} / {tc(total)}
        </span>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <ToolbarButton title="Split selected clip at playhead (S)" onClick={splitSelected} disabled={selectedIndex < 0}>
          ✂ Split
        </ToolbarButton>
        <ToolbarButton
          title="Move selected clip left"
          onClick={() => selectedIndex > 0 && reorderClips(selectedIndex, selectedIndex - 1)}
          disabled={selectedIndex <= 0}
        >
          ◀ Move
        </ToolbarButton>
        <ToolbarButton
          title="Move selected clip right"
          onClick={() => selectedIndex >= 0 && reorderClips(selectedIndex, selectedIndex + 1)}
          disabled={selectedIndex < 0 || selectedIndex >= clips.length - 1}
        >
          Move ▶
        </ToolbarButton>
        <ToolbarButton
          title="Mute / unmute selected clip"
          onClick={() => selectedClipId && toggleMute(selectedClipId)}
          disabled={selectedIndex < 0}
        >
          {selectedIndex >= 0 && clips[selectedIndex].mute ? '🔇 Muted' : '🔊 Audio'}
        </ToolbarButton>
        <ToolbarButton
          title="Delete selected clip (Del)"
          onClick={() => selectedClipId && removeClip(selectedClipId)}
          disabled={selectedIndex < 0}
        >
          🗑 Delete
        </ToolbarButton>
        <div className="flex-1" />
        <ToolbarButton title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
          ↶ Undo
        </ToolbarButton>
        <ToolbarButton title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
          ↷ Redo
        </ToolbarButton>
      </div>

      {/* Track */}
      <div className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        {clips.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            Add clips from the Library (＋ on a clip) to build your reel.
          </div>
        ) : (
          <div
            ref={trackInnerRef}
            onPointerDown={onTrackDown}
            className="relative h-full cursor-pointer"
            style={{ width: Math.max(total * PX_PER_SEC + 24, 200) }}
          >
            {/* Ruler strip (the whole track scrubs; this is just the visual band) */}
            <div className="absolute inset-x-0 top-0 h-5 border-b border-white/10 bg-black/30" />

            {/* 3-second hook marker */}
            {total >= HOOK_SEC && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-amber-400/70"
                style={{ left: HOOK_SEC * PX_PER_SEC }}
              >
                <span className="ml-1 text-[9px] uppercase text-amber-300/90">3s hook</span>
              </div>
            )}

            {/* Clip blocks */}
            <div className="absolute inset-x-0 top-5 bottom-1 flex">
              {clips.map((clip, i) => {
                const asset = assetById.get(clip.mediaId)
                const maxOut = asset?.probe.durationSec ?? clip.outSec
                const width = clipDuration(clip) * PX_PER_SEC
                const selected = clip.id === selectedClipId
                return (
                  <div
                    key={clip.id}
                    onClick={() => selectClip(clip.id)}
                    className={`group relative mx-px flex shrink-0 cursor-pointer items-center overflow-hidden rounded-md border ${
                      selected ? 'border-sky-400 ring-1 ring-sky-400/50' : 'border-white/10'
                    } bg-zinc-800/80`}
                    style={{ width }}
                  >
                    {asset && (
                      <img src={thumbUrl(asset.id)} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} className="h-full w-10 shrink-0 object-cover opacity-70" />
                    )}
                    <div className="min-w-0 px-2">
                      <div className="truncate text-[10px] text-zinc-200">{asset?.fileName ?? clip.mediaId}</div>
                      <div className="text-[9px] text-zinc-500">
                        {clipDuration(clip).toFixed(1)}s{clip.mute ? ' · muted' : ''}
                      </div>
                    </div>
                    {/* Trim handles */}
                    <div
                      onPointerDown={(e) => startTrim(e, clip, 'in', maxOut)}
                      className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-sky-400/0 hover:bg-sky-400/60 group-hover:bg-sky-400/30"
                      title="Trim start"
                    />
                    <div
                      onPointerDown={(e) => startTrim(e, clip, 'out', maxOut)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-sky-400/0 hover:bg-sky-400/60 group-hover:bg-sky-400/30"
                      title="Trim end"
                    />
                    {i < clips.length - 1 && <span className="sr-only">clip {i + 1}</span>}
                  </div>
                )
              })}
            </div>

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-rose-400"
              style={{ left: time * PX_PER_SEC }}
            >
              <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-rose-400" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
