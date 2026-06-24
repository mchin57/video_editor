import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioClip, CaptionSegment, Layer, ScriptLine } from '@shared/project'
import { audioClipEnd, effectiveOut } from '@shared/project'
import { layerLabel, makeTextLayer, visualDuration } from '@shared/layers'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { useEditor } from '@/state/store'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { snap } from '@/lib/snap'
import { formatTick, niceTimeStep, scaleTicks } from '@/lib/timescale'
import { thumbUrl, waveformUrl } from '@/ipc/client'

const DEFAULT_PPS = 48
const HOOK_SEC = 3
const SNAP_PX = 7
const RULER_H = 20
const LAYER_H = 28
const CAP_H = 22
const AUD_H = 30
const GAP = 3
const SCALE_H = 18

const EMPTY_LAYERS: Layer[] = []
const EMPTY_CAPTIONS: CaptionSegment[] = []
const EMPTY_SCRIPT: ScriptLine[] = []
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

const layerTint = (l: Layer): string =>
  l.content.kind === 'video'
    ? 'border-sky-400/40 bg-sky-500/20'
    : l.content.kind === 'image'
      ? 'border-orange-400/40 bg-orange-500/20'
      : 'border-violet-400/40 bg-violet-500/20'

const layerTintSel = (l: Layer): string =>
  l.content.kind === 'video'
    ? 'border-sky-300 ring-1 ring-sky-300/50'
    : l.content.kind === 'image'
      ? 'border-orange-300 ring-1 ring-orange-300/50'
      : 'border-violet-300 ring-1 ring-violet-300/50'

export function Timeline(): JSX.Element {
  const project = useProject((s) => s.project)
  const layers = project?.layers ?? EMPTY_LAYERS
  const captionSegs = project?.captions.enabled ? project.captions.segments : EMPTY_CAPTIONS
  const audioClips = project?.audioClips ?? EMPTY_AUDIO
  const script = project?.script ?? EMPTY_SCRIPT

  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectLayer = useUi((s) => s.selectLayer)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectCaption = useUi((s) => s.selectCaption)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const selectAudio = useUi((s) => s.selectAudio)

  const addLayer = useProject((s) => s.addLayer)
  const removeLayer = useProject((s) => s.removeLayer)
  const splitLayerAt = useProject((s) => s.splitLayerAt)
  const splitAudioAt = useProject((s) => s.splitAudioAt)
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

  const selectedLibId = useEditor((s) => s.selectedId)
  const previewAsset = layers.length === 0 && selectedLibId ? assetById.get(selectedLibId) : undefined
  const previewDur = previewAsset?.proxyReady ? previewAsset.probe.durationSec : 0
  const canPlay = layers.length > 0 || previewDur > 0

  const [pxPerSec, setPxPerSec] = useState(() => {
    const v = Number(localStorage.getItem('timelinePps'))
    return v >= 8 && v <= 240 ? v : DEFAULT_PPS
  })
  useEffect(() => {
    localStorage.setItem('timelinePps', String(pxPerSec))
  }, [pxPerSec])
  const pxPerSecRef = useRef(pxPerSec)
  pxPerSecRef.current = pxPerSec

  const scrollRef = useRef<HTMLDivElement>(null)
  const trackInnerRef = useRef<HTMLDivElement>(null)

  const audioEnd = useMemo(
    () =>
      audioClips.reduce(
        (m, a) => Math.max(m, audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)),
        0
      ),
    [audioClips, assetById]
  )
  const total = Math.max(visualDuration(layers), audioEnd)

  // Rows: front layer on top → background at the bottom of the layer band.
  const rows = useMemo(() => layers.slice().reverse(), [layers])

  // Vertical geometry.
  const layersTop = RULER_H
  const layersH = rows.length * (LAYER_H + GAP)
  const capTop = layersTop + layersH + GAP
  const capH = captionSegs.length > 0 ? CAP_H + GAP : 0
  const audTop = capTop + capH
  const audH = audioClips.length * (AUD_H + GAP)
  const scaleTop = audTop + audH + GAP
  const totalH = scaleTop + SCALE_H

  // Snap targets: layer + audio boundaries, playhead, 0, end.
  const snapTargets = useMemo(() => {
    const t = new Set<number>([0, total])
    for (const l of layers) {
      t.add(l.startSec)
      t.add(l.endSec)
    }
    for (const a of audioClips) {
      t.add(a.startSec)
      t.add(audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec))
    }
    return [...t]
  }, [layers, audioClips, assetById, total])
  const snapSec = (v: number): number => snap(v, snapTargets, SNAP_PX / pxPerSec)

  // Ctrl/Cmd + scroll = horizontal zoom anchored at the cursor.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const cur = pxPerSecRef.current
      const timeAtCursor = (el.scrollLeft + cursorX) / cur
      const next = clamp(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 8, 240)
      if (next === cur) return
      setPxPerSec(next)
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, timeAtCursor * next - cursorX)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const scrubToClientX = (clientX: number): void => {
    const inner = trackInnerRef.current
    if (!inner) return
    const x = clientX - inner.getBoundingClientRect().left
    setTime(clamp(x / pxPerSec, 0, Math.max(total, previewDur)))
  }
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

  // Drag a layer block: move in time, or trim its left/right edge.
  const startLayerDrag = (e: ReactPointerEvent, layer: Layer, mode: 'move' | 'start' | 'end'): void => {
    e.stopPropagation()
    e.preventDefault()
    setPlaying(false)
    selectLayer(layer.id)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, endSec } = layer
    const dur = endSec - startSec
    const srcDur =
      layer.content.kind === 'video'
        ? assetById.get(layer.content.mediaId)?.probe.durationSec ?? layer.content.outSec
        : 0
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / pxPerSec
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => {
          if (l.id !== layer.id) return l
          if (mode === 'move') {
            const ns = Math.max(0, snapSec(startSec + d))
            return { ...l, startSec: ns, endSec: ns + dur }
          }
          if (mode === 'start') {
            if (l.content.kind === 'video') {
              const c = layer.content.kind === 'video' ? layer.content : l.content
              const ni = clamp(c.inSec + d, 0, c.outSec - 0.1)
              const ns = Math.max(0, startSec + (ni - c.inSec))
              return { ...l, startSec: ns, content: { ...l.content, inSec: ni } }
            }
            return { ...l, startSec: clamp(snapSec(startSec + d), 0, l.endSec - 0.2) }
          }
          // end
          if (l.content.kind === 'video') {
            const c = layer.content.kind === 'video' ? layer.content : l.content
            const no = clamp(c.outSec + d, c.inSec + 0.1, srcDur)
            return { ...l, endSec: startSec + (no - c.inSec), content: { ...l.content, outSec: no } }
          }
          return { ...l, endSec: Math.max(l.startSec + 0.2, snapSec(endSec + d)) }
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

  // Drag a caption segment's time window (or its edges).
  const startCaptionDrag = (e: ReactPointerEvent, seg: CaptionSegment, mode: 'move' | 'start' | 'end'): void => {
    e.stopPropagation()
    e.preventDefault()
    selectCaption(seg.id)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, endSec } = seg
    const dur = endSec - startSec
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / pxPerSec
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
  const startAudioDrag = (e: ReactPointerEvent, clip: AudioClip, mode: 'move' | 'start' | 'end', maxOut: number): void => {
    e.stopPropagation()
    e.preventDefault()
    selectAudio(clip.id)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, inSec } = clip
    const effOut = effectiveOut(clip, maxOut)
    const ownEnd = startSec + (effOut - inSec)
    const others = snapTargets.filter((t) => Math.abs(t - startSec) > 1e-6 && Math.abs(t - ownEnd) > 1e-6)
    const audioSnap = (v: number): number => snap(v, others, SNAP_PX / pxPerSec)
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / pxPerSec
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

  // Split: a selected video layer at the playhead, else a selected audio clip.
  const selectedLayer = layers.find((l) => l.id === selectedLayerId)
  const selectedAudio = audioClips.find((a) => a.id === selectedAudioId)
  const selectedAudioDur = selectedAudio
    ? assetById.get(selectedAudio.mediaId)?.probe.durationSec ?? selectedAudio.outSec
    : 0
  const canSplit =
    (!!selectedLayer &&
      selectedLayer.content.kind === 'video' &&
      time > selectedLayer.startSec + 0.01 &&
      time < selectedLayer.endSec - 0.01) ||
    (!!selectedAudio && time > selectedAudio.startSec && time < audioClipEnd(selectedAudio, selectedAudioDur))
  const splitSelected = (): void => {
    if (selectedLayer && selectedLayer.content.kind === 'video') splitLayerAt(selectedLayer.id, time)
    else if (selectedAudio) splitAudioAt(selectedAudio.id, time, selectedAudioDur)
  }

  const addText = (): void => {
    const id = crypto.randomUUID()
    const start = usePlayback.getState().time
    addLayer(makeTextLayer(id, start, start + 3))
    selectLayer(id)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Transport / edit toolbar */}
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
        <button
          onClick={togglePlay}
          disabled={!canPlay}
          className="rounded bg-white/10 px-2 py-1 text-xs font-medium text-zinc-100 hover:bg-white/20 disabled:opacity-30"
          title={playing ? 'Pause (space)' : 'Play (space)'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="ml-1 w-24 font-mono text-[11px] text-zinc-400">
          {tc(time)} / {tc(Math.max(total, previewDur))}
        </span>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <ToolbarButton title="Split selected video layer or audio at the playhead (S)" onClick={splitSelected} disabled={!canSplit}>
          ✂ Split
        </ToolbarButton>
        <ToolbarButton title="Add a text layer at the playhead (T)" onClick={addText}>
          ＋ Text
        </ToolbarButton>
        <ToolbarButton
          title="Delete the selected layer (Del)"
          onClick={() => selectedLayerId && removeLayer(selectedLayerId)}
          disabled={!selectedLayerId}
        >
          🗑 Delete
        </ToolbarButton>
        <div className="flex-1" />
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

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {layers.length === 0 && audioClips.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            Add media from the Library (＋ on a clip) to build your reel.
          </div>
        ) : (
          <div
            ref={trackInnerRef}
            onPointerDown={onTrackDown}
            className="relative h-full cursor-pointer"
            style={{ width: Math.max(total * pxPerSec + 24, 200), minHeight: totalH }}
          >
            {/* Ruler */}
            <div className="absolute inset-x-0 top-0 h-5 border-b border-white/10 bg-black/30" />

            {/* 3-second hook marker */}
            {total >= HOOK_SEC && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-amber-400/70"
                style={{ left: HOOK_SEC * pxPerSec }}
              >
                <span className="ml-1 text-[9px] uppercase text-amber-300/90">3s hook</span>
              </div>
            )}

            {/* Script markers (pinned lines) on the ruler */}
            {script.map((l) =>
              l.atSec == null ? null : (
                <div
                  key={l.id}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setPlaying(false)
                    setTime(l.atSec!)
                  }}
                  title={l.text || 'Script marker'}
                  className="absolute top-0 z-20 h-5 cursor-pointer border-l border-amber-300"
                  style={{ left: l.atSec * pxPerSec }}
                >
                  <div className="-ml-[3px] h-1.5 w-1.5 rounded-sm bg-amber-300" />
                </div>
              )
            )}

            {/* Layer rows (front on top → background at the bottom) */}
            {rows.map((l, r) => {
              const left = l.startSec * pxPerSec
              const width = Math.max(12, (l.endSec - l.startSec) * pxPerSec)
              const selected = l.id === selectedLayerId
              const asset =
                l.content.kind === 'video' || l.content.kind === 'image'
                  ? assetById.get(l.content.mediaId)
                  : undefined
              return (
                <div
                  key={l.id}
                  onPointerDown={(e) => startLayerDrag(e, l, 'move')}
                  title={layerLabel(l)}
                  className={`group absolute flex cursor-move items-center gap-1 overflow-hidden rounded border pl-1 ${
                    selected ? layerTintSel(l) : layerTint(l)
                  } ${l.hidden ? 'opacity-40' : ''}`}
                  style={{ left, width, top: layersTop + r * (LAYER_H + GAP), height: LAYER_H }}
                >
                  {asset && (
                    <img
                      src={thumbUrl(asset.id)}
                      alt=""
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                      className="pointer-events-none h-full w-7 shrink-0 rounded-sm object-cover opacity-80"
                    />
                  )}
                  <span className="truncate text-[9px] font-medium text-zinc-100">
                    {l.content.kind === 'text' ? '🅣' : l.content.kind === 'image' ? '🖼' : '🎬'}&nbsp;
                    {asset?.fileName ?? layerLabel(l)}
                  </span>
                  <div
                    onPointerDown={(e) => startLayerDrag(e, l, 'start')}
                    className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/50"
                  />
                  <div
                    onPointerDown={(e) => startLayerDrag(e, l, 'end')}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/50"
                  />
                </div>
              )
            })}

            {/* Caption lane */}
            {captionSegs.map((seg) => {
              const left = seg.startSec * pxPerSec
              const width = Math.max(10, (seg.endSec - seg.startSec) * pxPerSec)
              const selected = seg.id === selectedCaptionId
              return (
                <div
                  key={seg.id}
                  onPointerDown={(e) => startCaptionDrag(e, seg, 'move')}
                  title={seg.text}
                  className={`group absolute flex cursor-move items-center overflow-hidden rounded border px-1.5 ${
                    selected ? 'border-emerald-300 ring-1 ring-emerald-300/50' : 'border-emerald-400/40'
                  } ${seg.enabled ? 'bg-emerald-500/25' : 'bg-zinc-600/30'}`}
                  style={{ left, width, top: capTop, height: CAP_H }}
                >
                  <span className="truncate text-[9px] font-medium text-emerald-100">CC&nbsp;&nbsp;{seg.text}</span>
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

            {/* Audio track (one row per clip) */}
            {audioClips.map((a, i) => {
              const asset = assetById.get(a.mediaId)
              const maxOut = asset?.probe.durationSec ?? (a.outSec || 1)
              const eo = effectiveOut(a, maxOut)
              const left = a.startSec * pxPerSec
              const width = Math.max(12, (eo - a.inSec) * pxPerSec)
              const selected = a.id === selectedAudioId
              return (
                <div
                  key={a.id}
                  onPointerDown={(e) => startAudioDrag(e, a, 'move', maxOut)}
                  title={asset?.fileName}
                  className={`group absolute flex cursor-move items-center overflow-hidden rounded border ${
                    selected ? 'border-sky-300 ring-1 ring-sky-300/50' : 'border-sky-400/40'
                  } bg-sky-500/15`}
                  style={{ left, width, top: audTop + i * (AUD_H + GAP), height: AUD_H }}
                >
                  {asset && (
                    <img
                      src={waveformUrl(asset.id)}
                      alt=""
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                      className="pointer-events-none absolute inset-y-0 opacity-70"
                      style={{
                        left: `${-(a.inSec / Math.max(0.01, eo - a.inSec)) * 100}%`,
                        width: `${(maxOut / Math.max(0.01, eo - a.inSec)) * 100}%`,
                        height: '100%',
                        objectFit: 'fill'
                      }}
                    />
                  )}
                  <span className="pointer-events-none absolute left-1.5 truncate text-[9px] font-medium text-sky-50">
                    {a.kind === 'extracted' ? '🎙' : '♪'}&nbsp;{asset?.fileName ?? a.mediaId}
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

            {/* Bottom time scale */}
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-white/10"
              style={{ top: scaleTop, height: SCALE_H }}
            >
              {(() => {
                const step = niceTimeStep(pxPerSec)
                return scaleTicks(total, step).map((t) => (
                  <div key={t} className="absolute top-0 h-full" style={{ left: t * pxPerSec }}>
                    <div className="h-2 w-px bg-white/25" />
                    <span className="ml-1 font-mono text-[9px] text-zinc-500">{formatTick(t, step)}</span>
                  </div>
                ))
              })()}
            </div>

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-rose-400"
              style={{ left: time * pxPerSec }}
            >
              <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-rose-400" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
