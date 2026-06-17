import { useMemo, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioClip, CaptionSegment, Clip, TextOverlay } from '@shared/project'
import { audioClipEnd, effectiveOut } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { clipDuration, clipStartTimes, locate, timelineDuration } from '@/lib/timeline'
import { makeOverlay } from '@/lib/overlays'
import { packRows, rowCount } from '@/lib/lanes'
import { snap } from '@/lib/snap'
import { thumbUrl, waveformUrl } from '@/ipc/client'

const PX_PER_SEC = 48
const HOOK_SEC = 3
const ROW_T = 22 // text/caption lane row height (px)
const ROW_A = 30 // audio lane row height (px)
const SNAP_PX = 7 // magnetic snap threshold

// Stable empty references (see PreviewStage note) to avoid re-render loops.
const EMPTY_CLIPS: Clip[] = []
const EMPTY_OVERLAYS: TextOverlay[] = []
const EMPTY_CAPTIONS: CaptionSegment[] = []
const EMPTY_AUDIO: AudioClip[] = []

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
  const overlays = project?.overlays ?? EMPTY_OVERLAYS
  const captionSegs = project?.captions.enabled ? project.captions.segments : EMPTY_CAPTIONS
  const selectedClipId = useProject((s) => s.selectedClipId)
  const selectedOverlayId = useUi((s) => s.selectedOverlayId)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectCaption = useUi((s) => s.selectCaption)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const selectAudio = useUi((s) => s.selectAudio)
  const audioClips = project?.audioClips ?? EMPTY_AUDIO
  const selectClip = useProject((s) => s.selectClip)
  const removeClip = useProject((s) => s.removeClip)
  const reorderClips = useProject((s) => s.reorderClips)
  const splitClipAt = useProject((s) => s.splitClipAt)
  const toggleMute = useProject((s) => s.toggleMute)
  const addOverlay = useProject((s) => s.addOverlay)
  const selectOverlay = useUi((s) => s.selectOverlay)
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

  const total = useMemo(() => {
    const videoTotal = timelineDuration(clips)
    const audioEnd = audioClips.reduce(
      (m, a) => Math.max(m, audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)),
      0
    )
    return Math.max(videoTotal, audioEnd)
  }, [clips, audioClips, assetById])
  const trackInnerRef = useRef<HTMLDivElement>(null)

  // Stack overlapping blocks into rows so they don't obscure each other, and
  // lay the lanes out vertically based on how many rows each needs.
  const overlayRows = useMemo(
    () => packRows(overlays.map((o) => ({ id: o.id, startSec: o.startSec, endSec: o.endSec }))),
    [overlays]
  )
  const captionRows = useMemo(
    () => packRows(captionSegs.map((c) => ({ id: c.id, startSec: c.startSec, endSec: c.endSec }))),
    [captionSegs]
  )
  const audioRows = useMemo(
    () =>
      packRows(
        audioClips.map((a) => ({
          id: a.id,
          startSec: a.startSec,
          endSec: audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)
        }))
      ),
    [audioClips, assetById]
  )
  const layout = useMemo(() => {
    const ruler = 20
    const gap = 4
    const clipsTop = ruler
    const clipsH = 48
    const textTop = clipsTop + clipsH + gap
    const textH = rowCount(overlayRows) * ROW_T
    const capTop = textTop + textH + gap
    const capH = rowCount(captionRows) * ROW_T
    const audTop = capTop + capH + gap
    const audH = rowCount(audioRows, 1) * ROW_A
    return { clipsTop, clipsH, textTop, textH, capTop, capH, audTop, audH, totalH: audTop + audH + gap }
  }, [overlayRows, captionRows, audioRows])

  // Magnetic snap targets: clip boundaries, audio-clip boundaries, playhead, 0.
  const snapTargets = useMemo(() => {
    const t = new Set<number>([0, total])
    const starts = clipStartTimes(clips)
    starts.forEach((s, i) => {
      t.add(s)
      t.add(s + clipDuration(clips[i]))
    })
    for (const a of audioClips) {
      t.add(a.startSec)
      t.add(audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec))
    }
    return [...t]
  }, [clips, audioClips, assetById, total])
  const snapSec = (v: number): number => snap(v, snapTargets, SNAP_PX / PX_PER_SEC)

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

  // Drag a text overlay's time window (or its edges) on the timeline.
  const startOverlayDrag = (
    e: ReactPointerEvent,
    o: TextOverlay,
    mode: 'move' | 'start' | 'end'
  ): void => {
    e.stopPropagation()
    e.preventDefault()
    selectOverlay(o.id)
    selectCaption(null)
    selectAudio(null)
    selectClip(null)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, endSec } = o
    const dur = endSec - startSec
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / PX_PER_SEC
      useProject.getState().liveUpdate((p) => ({
        ...p,
        overlays: p.overlays.map((x) => {
          if (x.id !== o.id) return x
          if (mode === 'move') {
            const ns = Math.max(0, snapSec(startSec + d))
            return { ...x, startSec: ns, endSec: ns + dur }
          }
          if (mode === 'start') return { ...x, startSec: clamp(snapSec(startSec + d), 0, x.endSec - 0.2) }
          return { ...x, endSec: Math.max(x.startSec + 0.2, snapSec(endSec + d)) }
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

  // Drag a caption segment's time window (or its edges) on the timeline.
  const startCaptionDrag = (
    e: ReactPointerEvent,
    seg: CaptionSegment,
    mode: 'move' | 'start' | 'end'
  ): void => {
    e.stopPropagation()
    e.preventDefault()
    selectCaption(seg.id)
    selectOverlay(null)
    selectAudio(null)
    selectClip(null)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, endSec } = seg
    const dur = endSec - startSec
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / PX_PER_SEC
      useProject.getState().liveUpdate((p) => ({
        ...p,
        captions: {
          ...p.captions,
          segments: p.captions.segments.map((s) => {
            if (s.id !== seg.id) return s
            if (mode === 'move') {
              const ns = Math.max(0, snapSec(startSec + d))
              return { ...s, startSec: ns, endSec: ns + dur }
            }
            if (mode === 'start') return { ...s, startSec: clamp(snapSec(startSec + d), 0, s.endSec - 0.1) }
            return { ...s, endSec: Math.max(s.startSec + 0.1, snapSec(endSec + d)) }
          })
        }
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

  // Drag an audio clip's position (or its edges) on the audio track.
  const startAudioDrag = (
    e: ReactPointerEvent,
    clip: AudioClip,
    mode: 'move' | 'start' | 'end',
    maxOut: number
  ): void => {
    e.stopPropagation()
    e.preventDefault()
    selectAudio(clip.id)
    selectClip(null)
    selectOverlay(null)
    selectCaption(null)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, inSec } = clip
    const effOut = effectiveOut(clip, maxOut)
    // Snap to other boundaries, but not this clip's own (would stick to origin).
    const ownEnd = startSec + (effOut - inSec)
    const others = snapTargets.filter(
      (t) => Math.abs(t - startSec) > 1e-6 && Math.abs(t - ownEnd) > 1e-6
    )
    const audioSnap = (v: number): number => snap(v, others, SNAP_PX / PX_PER_SEC)
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / PX_PER_SEC
      useProject.getState().liveUpdate((p) => ({
        ...p,
        audioClips: p.audioClips.map((a) => {
          if (a.id !== clip.id) return a
          if (mode === 'move') return { ...a, startSec: Math.max(0, audioSnap(startSec + d)) }
          if (mode === 'start') {
            const ni = clamp(inSec + d, 0, effOut - 0.1)
            return { ...a, inSec: ni, startSec: Math.max(0, startSec + (ni - inSec)) }
          }
          return { ...a, outSec: clamp(effOut + d, a.inSec + 0.1, maxOut) }
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
          title="Add hook text at the playhead (T)"
          onClick={() => {
            const id = crypto.randomUUID()
            const start = usePlayback.getState().time
            addOverlay(makeOverlay(id, start, start + 3))
            selectOverlay(id)
          }}
          disabled={clips.length === 0}
        >
          ＋ Text
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
      <div className="relative min-h-0 flex-1 overflow-auto">
        {clips.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            Add clips from the Library (＋ on a clip) to build your reel.
          </div>
        ) : (
          <div
            ref={trackInnerRef}
            onPointerDown={onTrackDown}
            className="relative h-full cursor-pointer"
            style={{ width: Math.max(total * PX_PER_SEC + 24, 200), minHeight: layout.totalH }}
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
            <div className="absolute inset-x-0 top-5 flex h-12">
              {clips.map((clip, i) => {
                const asset = assetById.get(clip.mediaId)
                const maxOut = asset?.probe.durationSec ?? clip.outSec
                const width = clipDuration(clip) * PX_PER_SEC
                const selected = clip.id === selectedClipId
                return (
                  <div
                    key={clip.id}
                    onClick={() => {
                      selectClip(clip.id)
                      selectOverlay(null)
                      selectCaption(null)
                      selectAudio(null)
                    }}
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

            {/* Text overlay lane */}
            <div className="absolute inset-x-0" style={{ top: layout.textTop, height: layout.textH }}>
              {overlays.map((o) => {
                const left = o.startSec * PX_PER_SEC
                const width = Math.max(10, (o.endSec - o.startSec) * PX_PER_SEC)
                const selected = o.id === selectedOverlayId
                return (
                  <div
                    key={o.id}
                    onPointerDown={(e) => startOverlayDrag(e, o, 'move')}
                    title={o.text}
                    className={`group absolute flex cursor-move items-center overflow-hidden rounded border px-1.5 ${
                      selected
                        ? 'border-violet-300 ring-1 ring-violet-300/50'
                        : 'border-violet-400/40'
                    } bg-violet-500/25`}
                    style={{ left, width, top: (overlayRows.get(o.id) ?? 0) * ROW_T, height: ROW_T - 2 }}
                  >
                    <span className="truncate text-[9px] font-medium text-violet-100">
                      T&nbsp;&nbsp;{o.text}
                    </span>
                    <div
                      onPointerDown={(e) => startOverlayDrag(e, o, 'start')}
                      className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-violet-200/70"
                    />
                    <div
                      onPointerDown={(e) => startOverlayDrag(e, o, 'end')}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-violet-200/70"
                    />
                  </div>
                )
              })}
            </div>

            {/* Caption lane */}
            <div className="absolute inset-x-0" style={{ top: layout.capTop, height: layout.capH }}>
              {captionSegs.map((seg) => {
                const left = seg.startSec * PX_PER_SEC
                const width = Math.max(10, (seg.endSec - seg.startSec) * PX_PER_SEC)
                const selected = seg.id === selectedCaptionId
                return (
                  <div
                    key={seg.id}
                    onPointerDown={(e) => startCaptionDrag(e, seg, 'move')}
                    title={seg.text}
                    className={`group absolute flex cursor-move items-center overflow-hidden rounded border px-1.5 ${
                      selected ? 'border-emerald-300 ring-1 ring-emerald-300/50' : 'border-emerald-400/40'
                    } ${seg.enabled ? 'bg-emerald-500/25' : 'bg-zinc-600/30'}`}
                    style={{ left, width, top: (captionRows.get(seg.id) ?? 0) * ROW_T, height: ROW_T - 2 }}
                  >
                    <span className="truncate text-[9px] font-medium text-emerald-100">
                      CC&nbsp;&nbsp;{seg.text}
                    </span>
                    <div
                      onPointerDown={(e) => startCaptionDrag(e, seg, 'start')}
                      className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-emerald-200/70"
                    />
                    <div
                      onPointerDown={(e) => startCaptionDrag(e, seg, 'end')}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-emerald-200/70"
                    />
                  </div>
                )
              })}
            </div>

            {/* Audio track lane (music / voiceover / extracted clip audio) */}
            <div className="absolute inset-x-0" style={{ top: layout.audTop, height: layout.audH }}>
              {audioClips.length === 0 && (
                <div className="flex h-6 items-center pl-1 text-[9px] text-zinc-600">
                  ♪ No audio — add an audio file (♪ in Library) or Extract a clip&apos;s audio
                </div>
              )}
              {audioClips.map((a) => {
                const asset = assetById.get(a.mediaId)
                const maxOut = asset?.probe.durationSec ?? (a.outSec || 1)
                const eo = effectiveOut(a, maxOut)
                const left = a.startSec * PX_PER_SEC
                const width = Math.max(12, (eo - a.inSec) * PX_PER_SEC)
                const selected = a.id === selectedAudioId
                return (
                  <div
                    key={a.id}
                    onPointerDown={(e) => startAudioDrag(e, a, 'move', maxOut)}
                    title={asset?.fileName}
                    className={`group absolute flex cursor-move items-center overflow-hidden rounded border ${
                      selected ? 'border-sky-300 ring-1 ring-sky-300/50' : 'border-sky-400/40'
                    } bg-sky-500/15`}
                    style={{ left, width, top: (audioRows.get(a.id) ?? 0) * ROW_A, height: ROW_A - 2 }}
                  >
                    {asset && (
                      <img
                        src={waveformUrl(asset.id)}
                        alt=""
                        onError={(e) => (e.currentTarget.style.display = 'none')}
                        className="h-full w-full object-cover opacity-70"
                      />
                    )}
                    <span className="pointer-events-none absolute left-1.5 truncate text-[9px] font-medium text-sky-50">
                      {a.duck ? '♪' : a.kind === 'extracted' ? '🎙' : '♪'}&nbsp;{asset?.fileName ?? a.mediaId}
                    </span>
                    <div
                      onPointerDown={(e) => startAudioDrag(e, a, 'start', maxOut)}
                      className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-sky-200/70"
                    />
                    <div
                      onPointerDown={(e) => startAudioDrag(e, a, 'end', maxOut)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-sky-200/70"
                    />
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
