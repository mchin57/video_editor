import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { AudioClip, CaptionSegment, Layer, ScriptLine } from '@shared/project'
import { audioClipEnd, denoiseOverridden, effectiveOut, stabilizeOverridden } from '@shared/project'
import { assetKind } from '@shared/media'
import { layerLabel, makeImageLayer, makeTextLayer, visualDuration } from '@shared/layers'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { useEditor } from '@/state/store'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import {
  layoutLanes,
  packRows,
  resizeRowH,
  rowCount,
  type LaneGeometry,
  type LaneViewPref,
  type Span
} from '@/lib/lanes'
import { useDragDepth } from '@/lib/dragDepth'
import { startPointerDrag } from '@/lib/pointerDrag'
import { trimVideoEnd, trimVideoStart } from '@/lib/timeline'
import { snap } from '@/lib/snap'
import { formatTick, niceTimeStep, scaleTicks } from '@/lib/timescale'
import { thumbUrl, waveformUrl } from '@/ipc/client'

const DEFAULT_PPS = 48
const HOOK_SEC = 3
const SNAP_PX = 7
const GUTTER = 84
const RULER_H = 20
const ROW_H = 26
const MIN_ROW_H = 16
const MAX_ROW_H = 60
const COLLAPSED_H = 14
const GAP = 4
const SCALE_H = 18
const DND_MIME = 'application/x-reel-asset'

const EMPTY_LAYERS: Layer[] = []
const EMPTY_CAPTIONS: CaptionSegment[] = []
const EMPTY_SCRIPT: ScriptLine[] = []
const EMPTY_AUDIO: AudioClip[] = []

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

/**
 * Auto-scrolls a container while a drag hovers near an edge. Feed the pointer's
 * X and/or Y on every move (`setX`/`setY`; an axis stays off until first fed); a
 * rAF loop nudges `scrollLeft`/`scrollTop` proportional to edge proximity and
 * calls `onScroll` after each real nudge, so the drag handler can re-apply its
 * position (which reads the live scroll offset). Horizontal callers (block
 * drags) use only `setX`; the vertical lane-resize uses only `setY`. Returns
 * `setX`/`setY`/`stop`; the loop starts immediately.
 */
function edgeAutoScroll(
  el: HTMLElement,
  onScroll: () => void
): { setX: (x: number) => void; setY: (y: number) => void; stop: () => void } {
  const EDGE = 40 // px from an edge where auto-scroll kicks in
  const MAX = 20 // px/frame at the very edge
  let x = -1
  let y = -1
  let raf = 0
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const rect = el.getBoundingClientRect()
    let scrolled = false
    if (x >= 0) {
      let v = 0
      if (x < rect.left + EDGE) v = -Math.min(1, (rect.left + EDGE - x) / EDGE) * MAX
      else if (x > rect.right - EDGE) v = Math.min(1, (x - (rect.right - EDGE)) / EDGE) * MAX
      if (v !== 0) {
        const before = el.scrollLeft
        el.scrollLeft = Math.max(0, before + v)
        if (el.scrollLeft !== before) scrolled = true
      }
    }
    if (y >= 0) {
      let v = 0
      if (y < rect.top + EDGE) v = -Math.min(1, (rect.top + EDGE - y) / EDGE) * MAX
      else if (y > rect.bottom - EDGE) v = Math.min(1, (y - (rect.bottom - EDGE)) / EDGE) * MAX
      if (v !== 0) {
        const before = el.scrollTop
        el.scrollTop = Math.max(0, before + v)
        if (el.scrollTop !== before) scrolled = true
      }
    }
    if (scrolled) onScroll()
  }
  raf = requestAnimationFrame(tick)
  return {
    setX: (nx: number) => {
      x = nx
    },
    setY: (ny: number) => {
      y = ny
    },
    stop: () => cancelAnimationFrame(raf)
  }
}
const spanOf = (l: { id: string; startSec: number; endSec: number }): Span => ({
  id: l.id,
  startSec: l.startSec,
  endSec: l.endSec
})

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

// Lane visual identity (the labeled bands the user likes — now purely a visual
// grouping over the unified layer stack).
const LANE_STYLE = {
  clips: { dot: 'bg-sky-400', tint: 'border-sky-400/30 bg-sky-500/10', block: 'border-sky-400/40 bg-sky-500/20', sel: 'border-sky-300 ring-1 ring-sky-300/50' },
  text: { dot: 'bg-violet-400', tint: 'border-violet-400/30 bg-violet-500/10', block: 'border-violet-400/40 bg-violet-500/20', sel: 'border-violet-300 ring-1 ring-violet-300/50' },
  image: { dot: 'bg-orange-400', tint: 'border-orange-400/30 bg-orange-500/10', block: 'border-orange-400/40 bg-orange-500/20', sel: 'border-orange-300 ring-1 ring-orange-300/50' },
  caption: { dot: 'bg-emerald-400', tint: 'border-emerald-400/30 bg-emerald-500/10', block: 'border-emerald-400/40 bg-emerald-500/25', sel: 'border-emerald-300 ring-1 ring-emerald-300/50' },
  audio: { dot: 'bg-sky-300', tint: 'border-sky-300/30 bg-sky-500/10', block: 'border-sky-400/40 bg-sky-500/15', sel: 'border-sky-300 ring-1 ring-sky-300/50' }
} as const

type LaneKey = keyof typeof LANE_STYLE

// Vertical geometry passed to the pure lane-layout math in `lib/lanes.ts`.
const LANE_GEOM: LaneGeometry = {
  rulerH: RULER_H,
  rowH: ROW_H,
  minRowH: MIN_ROW_H,
  maxRowH: MAX_ROW_H,
  collapsedH: COLLAPSED_H,
  gap: GAP,
  scaleH: SCALE_H
}

/** Per-lane view prefs — height-per-row (so clips scale with the lane) and a
 *  collapsed flag. Purely a UI preference like the zoom level, so it lives in
 *  localStorage (`timelineView`), not the project document. */
type TimelineView = Partial<Record<LaneKey, LaneViewPref>>

function loadTimelineView(): TimelineView {
  try {
    const v = JSON.parse(localStorage.getItem('timelineView') ?? '{}')
    return v && typeof v === 'object' ? (v as TimelineView) : {}
  } catch {
    return {}
  }
}

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
  const captionsGlobalSelected = useUi((s) => s.captionsGlobalSelected)
  const selectCaptionsGlobal = useUi((s) => s.selectCaptionsGlobal)

  const addLayer = useProject((s) => s.addLayer)
  const addVideoLayer = useProject((s) => s.addVideoLayer)
  const addAudioClip = useProject((s) => s.addAudioClip)
  const removeLayer = useProject((s) => s.removeLayer)
  const removeCaption = useProject((s) => s.removeCaption)
  const removeAudioClip = useProject((s) => s.removeAudioClip)
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

  // Per-lane height / collapse prefs, persisted across reloads.
  const [laneView, setLaneView] = useState<TimelineView>(loadTimelineView)
  useEffect(() => {
    localStorage.setItem('timelineView', JSON.stringify(laneView))
  }, [laneView])
  const patchLane = (key: LaneKey, patch: LaneViewPref): void =>
    setLaneView((v) => ({ ...v, [key]: { ...v[key], ...patch } }))
  const toggleLaneCollapsed = (key: LaneKey): void =>
    setLaneView((v) => ({ ...v, [key]: { ...v[key], collapsed: !v[key]?.collapsed } }))
  // While a lane resize is shrinking the track, we pin the scrollable height to
  // the tallest it reached this drag so the browser can't clamp scrollTop out
  // from under us (which would feed back into the height and run away). 0 = idle.
  const [resizeFloorH, setResizeFloorH] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const trackInnerRef = useRef<HTMLDivElement>(null)
  const gutterInnerRef = useRef<HTMLDivElement>(null)
  // Library-asset drag highlight — depth-counted so an abandoned drag can't
  // leave the drop ring stuck on.
  const assetDrag = useDragDepth((types) => types.includes(DND_MIME))

  const audioEnd = useMemo(
    () =>
      audioClips.reduce(
        (m, a) => Math.max(m, audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)),
        0
      ),
    [audioClips, assetById]
  )
  const total = Math.max(visualDuration(layers), audioEnd)

  // Group the unified stack into typed lanes (a visual grouping only).
  const grouped = useMemo(() => {
    const video = layers.filter((l) => l.content.kind === 'video')
    const text = layers.filter((l) => l.content.kind === 'text')
    const image = layers.filter((l) => l.content.kind === 'image')
    return {
      video,
      text,
      image,
      vRows: packRows(video.map(spanOf)),
      tRows: packRows(text.map(spanOf)),
      iRows: packRows(image.map(spanOf))
    }
  }, [layers])
  const capRows = useMemo(() => packRows(captionSegs.map(spanOf)), [captionSegs])
  const audRows = useMemo(
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

  // Lane layout: Clips / Text / Image always show (≥1 row as drop targets),
  // Captions only when present, Audio always.
  const laneDefs = [
    { key: 'clips' as const, label: 'Clips', rows: rowCount(grouped.vRows) },
    { key: 'text' as const, label: 'Text', rows: rowCount(grouped.tRows) },
    { key: 'image' as const, label: 'Image', rows: rowCount(grouped.iRows) },
    ...(captionSegs.length > 0 ? [{ key: 'caption' as const, label: 'Captions', rows: rowCount(capRows) }] : []),
    { key: 'audio' as const, label: 'Audio', rows: rowCount(audRows) }
  ]
  const { lanes, scaleTop, totalH } = layoutLanes(laneDefs, laneView, LANE_GEOM)
  const laneTop = (key: string): number => lanes.find((l) => l.key === key)?.top ?? RULER_H
  const laneRowHeight = (key: string): number => lanes.find((l) => l.key === key)?.rowH ?? ROW_H
  const laneCollapsed = (key: string): boolean => lanes.find((l) => l.key === key)?.collapsed ?? false

  // Resize a lane by dragging its header bubble (or bottom-edge handle)
  // vertically: the drag adjusts height-per-row so the clips scale with it.
  // Dragging past the track's top/bottom edge auto-scrolls, and the scroll delta
  // is folded into the height so you can keep growing a lane off-screen.
  const startLaneResize = (e: ReactPointerEvent, key: LaneKey, rows: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startRowH = clamp(laneView[key]?.rowH ?? ROW_H, MIN_ROW_H, MAX_ROW_H)
    const startTotalH = totalH
    const n = Math.max(1, rows)
    const sc = scrollRef.current
    const startScroll = sc?.scrollTop ?? 0
    const apply = (clientY: number): void => {
      const dy = clientY - startY + ((sc?.scrollTop ?? 0) - startScroll)
      const nextRowH = resizeRowH(startRowH, dy, rows, LANE_GEOM)
      patchLane(key, { rowH: nextRowH })
      // Only this lane's height moves, so the new total is exact. Keep the
      // scrollable height at the drag's high-water mark (never shrink mid-drag).
      const nextTotalH = startTotalH + n * (nextRowH - startRowH)
      setResizeFloorH((f) => Math.max(f, startTotalH, nextTotalH))
    }
    let last: PointerEvent | null = null
    let scroller: { setY: (y: number) => void; stop: () => void } | null = null
    const onMove = (ev: PointerEvent): void => {
      last = ev
      scroller?.setY(ev.clientY)
      apply(ev.clientY)
    }
    scroller = sc ? edgeAutoScroll(sc, () => last && apply(last.clientY)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      setResizeFloorH(0) // release the pin; the track settles to its true height
    })
  }

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

  // Keep the fixed gutter aligned as the track scrolls vertically.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const sync = (): void => {
      const g = gutterInnerRef.current
      if (g) g.style.transform = `translateY(${-el.scrollTop}px)`
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [])

  const xToSec = (clientX: number): number => {
    const inner = trackInnerRef.current
    if (!inner) return 0
    return Math.max(0, (clientX - inner.getBoundingClientRect().left) / pxPerSec)
  }
  const onTrackDown = (e: ReactPointerEvent): void => {
    e.preventDefault()
    setPlaying(false)
    setTime(clamp(xToSec(e.clientX), 0, Math.max(total, previewDur)))
    startPointerDrag((ev) => setTime(clamp(xToSec(ev.clientX), 0, Math.max(total, previewDur))))
  }

  // Drop a library asset onto the timeline → a layer (or audio clip) at the drop.
  const onDrop = (e: ReactDragEvent): void => {
    const id = e.dataTransfer.getData(DND_MIME)
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    assetDrag.reset()
    const asset = assetById.get(id)
    if (!asset || !asset.proxyReady) return
    const startSec = Math.max(0, snapSec(xToSec(e.clientX)))
    const nid = crypto.randomUUID()
    const kind = assetKind(asset)
    if (kind === 'image') {
      addLayer(makeImageLayer(nid, id, startSec, startSec + 3))
      selectLayer(nid)
    } else if (kind === 'audio') {
      addAudioClip({
        id: nid,
        mediaId: id,
        startSec,
        inSec: 0,
        outSec: asset.probe.durationSec,
        gainDb: 0,
        fadeInSec: 0,
        fadeOutSec: 0,
        duck: false,
        kind: 'audio'
      })
      selectAudio(nid)
    } else {
      addVideoLayer(nid, id, startSec, asset.probe.durationSec, !!asset.probe.audio)
      selectLayer(nid)
    }
  }
  const onDragOver = (e: ReactDragEvent): void => {
    if (!e.dataTransfer.types.includes(DND_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
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
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const deltaFor = (clientX: number): number =>
      (clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)) / pxPerSec
    const { startSec, endSec } = layer
    const dur = endSec - startSec
    const srcDur =
      layer.content.kind === 'video'
        ? assetById.get(layer.content.mediaId)?.probe.durationSec ?? layer.content.outSec
        : 0
    let last: PointerEvent | null = null
    let scroller: { setX: (x: number) => void; stop: () => void } | null = null
    const onMove = (ev: PointerEvent): void => {
      last = ev
      scroller?.setX(ev.clientX)
      const d = deltaFor(ev.clientX)
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => {
          if (l.id !== layer.id) return l
          if (mode === 'move') {
            const ns = Math.max(0, snapSec(startSec + d))
            return { ...l, startSec: ns, endSec: ns + dur }
          }
          if (mode === 'start') {
            if (layer.content.kind === 'video') {
              // Freeze-aware: drops holds trimmed past and keeps the window
              // invariant (computed from the drag-start snapshot).
              const c = layer.content
              return trimVideoStart(layer, c, clamp(c.inSec + d, 0, c.outSec - 0.1))
            }
            return { ...l, startSec: clamp(snapSec(startSec + d), 0, l.endSec - 0.2) }
          }
          // end
          if (layer.content.kind === 'video') {
            const c = layer.content
            return trimVideoEnd(layer, c, clamp(c.outSec + d, c.inSec + 0.1, srcDur))
          }
          return { ...l, endSec: Math.max(l.startSec + 0.2, snapSec(endSec + d)) }
        })
      }))
    }
    scroller = sc ? edgeAutoScroll(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      useProject.getState().commitLive(before)
    })
  }

  const startCaptionDrag = (e: ReactPointerEvent, seg: CaptionSegment, mode: 'move' | 'start' | 'end'): void => {
    e.stopPropagation()
    e.preventDefault()
    selectCaption(seg.id)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const deltaFor = (clientX: number): number =>
      (clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)) / pxPerSec
    const { startSec, endSec } = seg
    const dur = endSec - startSec
    let last: PointerEvent | null = null
    let scroller: { setX: (x: number) => void; stop: () => void } | null = null
    const onMove = (ev: PointerEvent): void => {
      last = ev
      scroller?.setX(ev.clientX)
      const d = deltaFor(ev.clientX)
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
    scroller = sc ? edgeAutoScroll(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      useProject.getState().commitLive(before)
    })
  }

  const startAudioDrag = (e: ReactPointerEvent, clip: AudioClip, mode: 'move' | 'start' | 'end', maxOut: number): void => {
    e.stopPropagation()
    e.preventDefault()
    selectAudio(clip.id)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const deltaFor = (clientX: number): number =>
      (clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)) / pxPerSec
    const { startSec, inSec } = clip
    const effOut = effectiveOut(clip, maxOut)
    const ownEnd = startSec + (effOut - inSec)
    const others = snapTargets.filter((t) => Math.abs(t - startSec) > 1e-6 && Math.abs(t - ownEnd) > 1e-6)
    const audioSnap = (v: number): number => snap(v, others, SNAP_PX / pxPerSec)
    let last: PointerEvent | null = null
    let scroller: { setX: (x: number) => void; stop: () => void } | null = null
    const onMove = (ev: PointerEvent): void => {
      last = ev
      scroller?.setX(ev.clientX)
      const d = deltaFor(ev.clientX)
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
    scroller = sc ? edgeAutoScroll(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      useProject.getState().commitLive(before)
    })
  }

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

  // Delete whatever is selected, mirroring the Del keybind's priority (App.tsx):
  // layer → caption → audio.
  const canDelete = !!(selectedLayerId || selectedCaptionId || selectedAudioId)
  const deleteSelected = (): void => {
    if (selectedLayerId) removeLayer(selectedLayerId)
    else if (selectedCaptionId) {
      removeCaption(selectedCaptionId)
      selectCaption(null)
    } else if (selectedAudioId) {
      removeAudioClip(selectedAudioId)
      selectAudio(null)
    }
  }

  const addText = (): void => {
    const id = crypto.randomUUID()
    const start = usePlayback.getState().time
    addLayer(makeTextLayer(id, start, start + 3))
    selectLayer(id)
  }

  // Render one layer block within its lane.
  const layerBlock = (l: Layer, laneKey: 'clips' | 'text' | 'image', rows: Map<string, number>): JSX.Element => {
    const left = l.startSec * pxPerSec
    const width = Math.max(12, (l.endSec - l.startSec) * pxPerSec)
    const selected = l.id === selectedLayerId
    const asset = l.content.kind === 'video' || l.content.kind === 'image' ? assetById.get(l.content.mediaId) : undefined
    const st = LANE_STYLE[laneKey]
    const rowH = laneRowHeight(laneKey)
    return (
      <div
        key={l.id}
        onPointerDown={(e) => startLayerDrag(e, l, 'move')}
        title={layerLabel(l)}
        className={`group absolute flex cursor-move items-center gap-1 overflow-hidden rounded border pl-1 ${
          selected ? st.sel : st.block
        } ${l.hidden ? 'opacity-40' : ''}`}
        style={{ left, width, top: laneTop(laneKey) + (rows.get(l.id) ?? 0) * rowH, height: rowH - 2 }}
      >
        {asset && (
          <img
            src={thumbUrl(asset.id)}
            alt=""
            onError={(e) => (e.currentTarget.style.display = 'none')}
            className="pointer-events-none h-full w-6 shrink-0 rounded-sm object-cover opacity-80"
          />
        )}
        <span className="truncate text-[9px] font-medium text-zinc-100">
          {l.content.kind === 'text' ? '🅣' : l.content.kind === 'image' ? '🖼' : '🎬'}&nbsp;
          {asset?.fileName ?? layerLabel(l)}
        </span>
        {l.content.kind === 'video' && stabilizeOverridden(l.content) && (
          <span
            className={`pointer-events-none absolute right-2 top-0.5 rounded px-1 text-[8px] font-bold leading-tight ${
              l.content.stabilize ? 'bg-emerald-500/80 text-emerald-50' : 'bg-zinc-500/80 text-zinc-100 line-through'
            }`}
            title={`Stabilization forced ${l.content.stabilize ? 'on' : 'off'} for this clip (overrides the project default)`}
          >
            S
          </span>
        )}
        <div onPointerDown={(e) => startLayerDrag(e, l, 'start')} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/50" />
        <div onPointerDown={(e) => startLayerDrag(e, l, 'end')} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-white/50" />
      </div>
    )
  }

  const isEmpty = layers.length === 0 && audioClips.length === 0

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
        <ToolbarButton title="Delete the selected layer, caption, or audio clip (Del)" onClick={deleteSelected} disabled={!canDelete}>
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

      <div className="flex min-h-0 flex-1">
        {/* Fixed left gutter with lane labels */}
        <div className="relative shrink-0 overflow-hidden border-r border-white/10 bg-zinc-900/50" style={{ width: GUTTER }}>
          <div ref={gutterInnerRef} className="absolute inset-x-0 top-0 will-change-transform" style={{ height: totalH }}>
            <div className="absolute inset-x-0 top-0 flex items-center border-b border-white/10 px-2" style={{ height: RULER_H }}>
              <span className="text-[8px] font-semibold uppercase tracking-wider text-zinc-600">Tracks</span>
            </div>
            {lanes.map((lane) => {
              const st = LANE_STYLE[lane.key]
              // The Captions label is also a control: click it to edit the
              // lane-wide caption style (every caption without its own override).
              const isCaption = lane.key === 'caption'
              const selected = isCaption && captionsGlobalSelected
              return (
                <div
                  key={lane.key}
                  // Drag the bubble body vertically to resize; double-click to
                  // collapse/expand. Caption bubbles also select on press.
                  onPointerDown={(e) => {
                    if (isCaption) selectCaptionsGlobal()
                    if (!lane.collapsed) startLaneResize(e, lane.key, lane.rows)
                  }}
                  onDoubleClick={() => toggleLaneCollapsed(lane.key)}
                  title={`${isCaption ? 'Click to edit all captions · ' : ''}drag to resize · double-click to collapse`}
                  className={`absolute inset-x-1 flex select-none items-center gap-1 overflow-hidden rounded-md border px-1 ${st.tint} ${
                    lane.collapsed ? 'cursor-pointer' : 'cursor-ns-resize'
                  } ${isCaption ? 'hover:brightness-125' : ''} ${selected ? st.sel : ''}`}
                  style={{ top: lane.top + 1, height: Math.max(0, lane.height - 2) }}
                >
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={() => toggleLaneCollapsed(lane.key)}
                    title={lane.collapsed ? 'Expand lane' : 'Collapse lane'}
                    className="shrink-0 text-[9px] leading-none text-zinc-400 hover:text-zinc-100"
                  >
                    {lane.collapsed ? '▸' : '▾'}
                  </button>
                  <span className={`h-2 w-2 shrink-0 rounded-sm ${st.dot}`} />
                  <span className="truncate text-[10px] font-medium leading-none text-zinc-200">{lane.label}</span>
                  {isCaption && !lane.collapsed && <span className="ml-auto text-[9px] text-emerald-300/80">✎</span>}
                  {/* Bottom-edge resize handle (hidden while collapsed). */}
                  {!lane.collapsed && (
                    <div
                      onPointerDown={(e) => startLaneResize(e, lane.key, lane.rows)}
                      onDoubleClick={(e) => e.stopPropagation()}
                      title="Drag to resize lane"
                      className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-white/30"
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Horizontally-scrolling track (also the library drop target) */}
        <div
          ref={scrollRef}
          className={`relative min-h-0 flex-1 overflow-auto ${assetDrag.active ? 'ring-2 ring-inset ring-sky-400/60' : ''}`}
          onDragEnter={assetDrag.onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={assetDrag.onDragLeave}
          onDrop={onDrop}
        >
          <div
            ref={trackInnerRef}
            onPointerDown={onTrackDown}
            className="relative h-full cursor-pointer"
            style={{ width: Math.max(total * pxPerSec + 24, 200), minWidth: '100%', minHeight: Math.max(totalH, resizeFloorH) }}
          >
            {/* Ruler */}
            <div className="absolute inset-x-0 top-0 border-b border-white/10 bg-black/30" style={{ height: RULER_H }} />

            {/* 3-second hook marker */}
            {total >= HOOK_SEC && (
              <div className="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-amber-400/70" style={{ left: HOOK_SEC * pxPerSec }}>
                <span className="ml-1 text-[9px] uppercase text-amber-300/90">3s hook</span>
              </div>
            )}

            {/* Script markers */}
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
                  className="absolute top-0 z-20 cursor-pointer border-l border-amber-300"
                  style={{ left: l.atSec * pxPerSec, height: RULER_H }}
                >
                  <div className="-ml-[3px] h-1.5 w-1.5 rounded-sm bg-amber-300" />
                </div>
              )
            )}

            {/* Layer lanes */}
            {!laneCollapsed('clips') && grouped.video.map((l) => layerBlock(l, 'clips', grouped.vRows))}
            {!laneCollapsed('text') && grouped.text.map((l) => layerBlock(l, 'text', grouped.tRows))}
            {!laneCollapsed('image') && grouped.image.map((l) => layerBlock(l, 'image', grouped.iRows))}

            {/* Caption lane */}
            {!laneCollapsed('caption') && captionSegs.map((seg) => {
              const left = seg.startSec * pxPerSec
              const width = Math.max(10, (seg.endSec - seg.startSec) * pxPerSec)
              const selected = seg.id === selectedCaptionId
              const rowH = laneRowHeight('caption')
              return (
                <div
                  key={seg.id}
                  onPointerDown={(e) => startCaptionDrag(e, seg, 'move')}
                  title={seg.text}
                  className={`group absolute flex cursor-move items-center overflow-hidden rounded border px-1.5 ${
                    selected ? LANE_STYLE.caption.sel : seg.enabled ? LANE_STYLE.caption.block : 'border-zinc-500/40 bg-zinc-600/30'
                  }`}
                  style={{ left, width, top: laneTop('caption') + (capRows.get(seg.id) ?? 0) * rowH, height: rowH - 2 }}
                >
                  <span className="truncate text-[9px] font-medium text-emerald-100">CC&nbsp;&nbsp;{seg.text}</span>
                  <div onPointerDown={(e) => startCaptionDrag(e, seg, 'start')} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-emerald-200/70" />
                  <div onPointerDown={(e) => startCaptionDrag(e, seg, 'end')} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-emerald-200/70" />
                </div>
              )
            })}

            {/* Audio lane */}
            {!laneCollapsed('audio') && audioClips.map((a) => {
              const asset = assetById.get(a.mediaId)
              const maxOut = asset?.probe.durationSec ?? (a.outSec || 1)
              const eo = effectiveOut(a, maxOut)
              const left = a.startSec * pxPerSec
              const width = Math.max(12, (eo - a.inSec) * pxPerSec)
              const selected = a.id === selectedAudioId
              const rowH = laneRowHeight('audio')
              return (
                <div
                  key={a.id}
                  onPointerDown={(e) => startAudioDrag(e, a, 'move', maxOut)}
                  title={asset?.fileName}
                  className={`group absolute flex cursor-move items-center overflow-hidden rounded border ${
                    selected ? LANE_STYLE.audio.sel : LANE_STYLE.audio.block
                  }`}
                  style={{ left, width, top: laneTop('audio') + (audRows.get(a.id) ?? 0) * rowH, height: rowH - 2 }}
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
                  {denoiseOverridden(a) && (
                    <span
                      className={`pointer-events-none absolute right-2 top-0.5 rounded px-1 text-[8px] font-bold leading-tight ${
                        a.denoise ? 'bg-emerald-500/80 text-emerald-50' : 'bg-zinc-500/80 text-zinc-100 line-through'
                      }`}
                      title={`Noise filter forced ${a.denoise ? 'on' : 'off'} for this clip (overrides the project default)`}
                    >
                      N
                    </span>
                  )}
                  <div onPointerDown={(e) => startAudioDrag(e, a, 'start', maxOut)} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-sky-200/70" />
                  <div onPointerDown={(e) => startAudioDrag(e, a, 'end', maxOut)} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-sky-200/70" />
                </div>
              )
            })}

            {/* Bottom time scale */}
            <div className="pointer-events-none absolute inset-x-0 border-t border-white/10" style={{ top: scaleTop, height: SCALE_H }}>
              {(() => {
                const step = niceTimeStep(pxPerSec)
                return scaleTicks(Math.max(total, 1), step).map((t) => (
                  <div key={t} className="absolute top-0 h-full" style={{ left: t * pxPerSec }}>
                    <div className="h-2 w-px bg-white/25" />
                    <span className="ml-1 font-mono text-[9px] text-zinc-500">{formatTick(t, step)}</span>
                  </div>
                ))
              })()}
            </div>

            {/* Playhead */}
            <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-rose-400" style={{ left: time * pxPerSec }}>
              <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-rose-400" />
            </div>

            {/* Empty-state hint */}
            {isEmpty && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-600">
                Drag media here, or use ＋ PH / ＋ End on a library clip.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
