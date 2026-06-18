import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioClip, CaptionSegment, Clip, ImageOverlay, ScriptLine, TextOverlay } from '@shared/project'
import { audioClipEnd, effectiveOut } from '@shared/project'
import { useLibrary } from '@/hooks/useMedia'
import { useProject } from '@/state/projectStore'
import { useEditor } from '@/state/store'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { clipDuration, clipStartTimes, locate, timelineDuration } from '@/lib/timeline'
import { makeOverlay } from '@/lib/overlays'
import { packRows, rowCount } from '@/lib/lanes'
import { snap } from '@/lib/snap'
import { formatTick, niceTimeStep, scaleTicks } from '@/lib/timescale'
import { thumbUrl, waveformUrl } from '@/ipc/client'

const DEFAULT_PPS = 48 // default pixels per second (horizontal zoom)
const HOOK_SEC = 3
const SNAP_PX = 7 // magnetic snap threshold (px)
const LANE_MIN = 16 // min per-row lane height
const LANE_MAX = 160 // max per-row lane height
const GUTTER = 96 // fixed left track-header column width (px)
const COLLAPSED_H = 16 // lane height when minimized

type LaneKey = 'clips' | 'text' | 'image' | 'caption' | 'audio'
type LaneHeights = Record<LaneKey, number>
type Collapsed = Record<LaneKey, boolean>
const DEFAULT_LANES: LaneHeights = { clips: 48, text: 22, image: 30, caption: 22, audio: 30 }
const DEFAULT_COLLAPSED: Collapsed = { clips: false, text: false, image: false, caption: false, audio: false }

interface TimelineView {
  pxPerSec: number
  laneH: LaneHeights
  collapsed: Collapsed
}
function loadView(): TimelineView {
  try {
    const v = JSON.parse(localStorage.getItem('timelineView') ?? '{}')
    return {
      pxPerSec: v.pxPerSec ?? DEFAULT_PPS,
      laneH: { ...DEFAULT_LANES, ...(v.laneH ?? {}) },
      collapsed: { ...DEFAULT_COLLAPSED, ...(v.collapsed ?? {}) }
    }
  } catch {
    return { pxPerSec: DEFAULT_PPS, laneH: DEFAULT_LANES, collapsed: DEFAULT_COLLAPSED }
  }
}

// Vertical geometry of the track: each lane's top + height, plus the bottom
// time scale and overall content height. Computed from lane heights + row counts.
interface Layout {
  clipsTop: number
  clipsH: number
  textTop: number
  textH: number
  imgTop: number
  imgH: number
  capTop: number
  capH: number
  audTop: number
  audH: number
  textRows: number
  imgRows: number
  capRows: number
  audRows: number
  scaleTop: number
  scaleH: number
  totalH: number
}

// Return `snap` with only the given lane's height replaced by the live value —
// used to hold everything below a shrinking lane in place during a resize drag.
function freezeBelow(snap: Layout, live: Layout, lane: LaneKey): Layout {
  switch (lane) {
    case 'clips':
      return { ...snap, clipsH: live.clipsH }
    case 'text':
      return { ...snap, textH: live.textH }
    case 'image':
      return { ...snap, imgH: live.imgH }
    case 'caption':
      return { ...snap, capH: live.capH }
    case 'audio':
      return { ...snap, audH: live.audH }
  }
}

// Stable empty references (see PreviewStage note) to avoid re-render loops.
const EMPTY_CLIPS: Clip[] = []
const EMPTY_OVERLAYS: TextOverlay[] = []
const EMPTY_IMAGES: ImageOverlay[] = []
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

export function Timeline(): JSX.Element {
  const project = useProject((s) => s.project)
  const clips = project?.clips ?? EMPTY_CLIPS
  const overlays = project?.overlays ?? EMPTY_OVERLAYS
  const imageOverlays = project?.imageOverlays ?? EMPTY_IMAGES
  const captionSegs = project?.captions.enabled ? project.captions.segments : EMPTY_CAPTIONS
  const selectedClipId = useProject((s) => s.selectedClipId)
  const selectedOverlayId = useUi((s) => s.selectedOverlayId)
  const selectedImageId = useUi((s) => s.selectedImageId)
  const selectImage = useUi((s) => s.selectImage)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectCaption = useUi((s) => s.selectCaption)
  const selectedAudioId = useUi((s) => s.selectedAudioId)
  const selectAudio = useUi((s) => s.selectAudio)
  const audioClips = project?.audioClips ?? EMPTY_AUDIO
  const script = project?.script ?? EMPTY_SCRIPT
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

  // With an empty timeline, the preview falls back to the selected library clip
  // (see PreviewStage). Mirror that here so transport reflects what's on screen:
  // a ready, selected clip is playable even before it's added to the timeline.
  const selectedLibId = useEditor((s) => s.selectedId)
  const previewAsset = clips.length === 0 && selectedLibId ? assetById.get(selectedLibId) : undefined
  const previewDur = previewAsset?.proxyReady ? previewAsset.probe.durationSec : 0
  const canPlay = clips.length > 0 || previewDur > 0

  // Timeline view (persisted): horizontal zoom + per-lane heights + collapsed lanes.
  const [pxPerSec, setPxPerSec] = useState(() => loadView().pxPerSec)
  const [laneH, setLaneH] = useState<LaneHeights>(() => loadView().laneH)
  const [collapsed, setCollapsed] = useState<Collapsed>(() => loadView().collapsed)
  useEffect(() => {
    localStorage.setItem('timelineView', JSON.stringify({ pxPerSec, laneH, collapsed }))
  }, [pxPerSec, laneH, collapsed])
  const toggleCollapse = (lane: LaneKey): void =>
    setCollapsed((prev) => ({ ...prev, [lane]: !prev[lane] }))
  // Active lane resize, with a snapshot of the layout when the drag began.
  const [resize, setResize] = useState<{ lane: LaneKey; snap: Layout } | null>(null)
  const pxPerSecRef = useRef(pxPerSec)
  pxPerSecRef.current = pxPerSec
  const scrollRef = useRef<HTMLDivElement>(null)
  const gutterInnerRef = useRef<HTMLDivElement>(null)

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
  const imageRows = useMemo(
    () => packRows(imageOverlays.map((o) => ({ id: o.id, startSec: o.startSec, endSec: o.endSec }))),
    [imageOverlays]
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
  const liveLayout = useMemo<Layout>(() => {
    const ruler = 20
    const gap = 6 // also the resize-handle strip below each lane
    const clipsTop = ruler
    const clipsH = collapsed.clips ? COLLAPSED_H : laneH.clips
    const textRows = rowCount(overlayRows)
    const imgRows = rowCount(imageRows)
    const capRows = rowCount(captionRows)
    const audRows = rowCount(audioRows, 1)
    const textTop = clipsTop + clipsH + gap
    const textH = collapsed.text ? COLLAPSED_H : textRows * laneH.text
    const imgTop = textTop + textH + gap
    const imgH = collapsed.image ? COLLAPSED_H : imgRows * laneH.image
    const capTop = imgTop + imgH + gap
    const capH = collapsed.caption ? COLLAPSED_H : capRows * laneH.caption
    const audTop = capTop + capH + gap
    const audH = collapsed.audio ? COLLAPSED_H : audRows * laneH.audio
    const scaleTop = audTop + audH + gap
    const scaleH = 18
    return {
      clipsTop, clipsH, textTop, textH, imgTop, imgH, capTop, capH, audTop, audH,
      textRows, imgRows, capRows, audRows,
      scaleTop, scaleH,
      totalH: scaleTop + scaleH
    }
  }, [overlayRows, imageRows, captionRows, audioRows, laneH, collapsed])

  // While dragging a lane *shorter*, freeze the lanes below it (and the total
  // scroll height) at their pre-drag positions: black space opens under the lane
  // and nothing below moves until release. Without this, the shrinking content
  // clamps the scrollbar, which fed back into the drag and made it accelerate.
  // Expanding still reflows normally so there's room to grow into.
  const layout: Layout =
    resize && liveLayout.totalH < resize.snap.totalH
      ? freezeBelow(resize.snap, liveLayout, resize.lane)
      : liveLayout

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
  const snapSec = (v: number): number => snap(v, snapTargets, SNAP_PX / pxPerSec)

  // Ctrl/Cmd + scroll = horizontal zoom, anchored at the cursor. Native listener
  // (passive:false) so we can preventDefault the browser's ctrl-wheel page zoom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left // px within the viewport
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

  // Keep the fixed left gutter aligned as the track scrolls vertically. Updated
  // imperatively so we don't re-render every lane on each scroll tick.
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
  }, [clips.length])

  // Drag a lane's header bubble (or its bottom-edge handle) to resize just that
  // lane (per-row height). Height tracks the pointer in *content* space so that
  // when the drag reaches a viewport edge we can keep growing/shrinking the lane
  // while auto-scrolling the track to follow.
  const startLaneResize = (e: ReactPointerEvent, lane: LaneKey, rows: number): void => {
    e.stopPropagation()
    e.preventDefault()
    setResize({ lane, snap: liveLayout })
    const el = scrollRef.current
    const startY = e.clientY
    const startH = laneH[lane]
    const startScroll = el?.scrollTop ?? 0
    const r = Math.max(1, rows)
    let lastY = startY
    let raf = 0

    const apply = (): void => {
      const scrolled = (el?.scrollTop ?? 0) - startScroll
      const nh = clamp(startH + (lastY - startY + scrolled) / r, LANE_MIN, LANE_MAX)
      setLaneH((prev) => ({ ...prev, [lane]: nh }))
    }

    // Auto-scroll while the pointer sits inside the top/bottom edge band.
    const EDGE = 28 // px
    const tick = (): void => {
      if (el) {
        const rect = el.getBoundingClientRect()
        let v = 0
        if (lastY > rect.bottom - EDGE) v = Math.min(16, (lastY - (rect.bottom - EDGE)) / 2)
        else if (lastY < rect.top + EDGE) v = -Math.min(16, (rect.top + EDGE - lastY) / 2)
        if (v !== 0) {
          const max = el.scrollHeight - el.clientHeight
          const next = clamp(el.scrollTop + v, 0, max)
          if (next !== el.scrollTop) {
            el.scrollTop = next
            apply()
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }

    const onMove = (ev: PointerEvent): void => {
      lastY = ev.clientY
      apply()
    }
    const onUp = (): void => {
      cancelAnimationFrame(raf)
      setResize(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    raf = requestAnimationFrame(tick)
  }

  const selectedIndex = clips.findIndex((c) => c.id === selectedClipId)

  const scrubToClientX = (clientX: number): void => {
    const inner = trackInnerRef.current
    if (!inner) return
    const x = clientX - inner.getBoundingClientRect().left
    setTime(clamp(x / pxPerSec, 0, total))
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
      const d = (ev.clientX - startX) / pxPerSec
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
    selectImage(null)
    selectCaption(null)
    selectAudio(null)
    selectClip(null)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, endSec } = o
    const dur = endSec - startSec
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / pxPerSec
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

  // Drag an image overlay's time window (or its edges) on the timeline.
  const startImageOverlayDrag = (
    e: ReactPointerEvent,
    o: ImageOverlay,
    mode: 'move' | 'start' | 'end'
  ): void => {
    e.stopPropagation()
    e.preventDefault()
    selectImage(o.id)
    selectOverlay(null)
    selectCaption(null)
    selectAudio(null)
    selectClip(null)
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const { startSec, endSec } = o
    const dur = endSec - startSec
    const onMove = (ev: PointerEvent): void => {
      const d = (ev.clientX - startX) / pxPerSec
      useProject.getState().liveUpdate((p) => ({
        ...p,
        imageOverlays: p.imageOverlays.map((x) => {
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
    selectImage(null)
    selectAudio(null)
    selectClip(null)
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
    selectImage(null)
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

  // Track-header bubbles for the fixed left gutter, aligned to each lane's band.
  const laneMeta: {
    key: LaneKey
    label: string
    top: number
    height: number
    rows: number
    dot: string
    tint: string
  }[] = [
    { key: 'clips', label: 'Clips', top: layout.clipsTop, height: layout.clipsH, rows: 1, dot: 'bg-sky-400', tint: 'border-sky-400/30 bg-sky-500/10' },
    { key: 'text', label: 'Text', top: layout.textTop, height: layout.textH, rows: layout.textRows, dot: 'bg-violet-400', tint: 'border-violet-400/30 bg-violet-500/10' },
    { key: 'image', label: 'Image', top: layout.imgTop, height: layout.imgH, rows: layout.imgRows, dot: 'bg-orange-400', tint: 'border-orange-400/30 bg-orange-500/10' },
    { key: 'caption', label: 'Captions', top: layout.capTop, height: layout.capH, rows: layout.capRows, dot: 'bg-emerald-400', tint: 'border-emerald-400/30 bg-emerald-500/10' },
    { key: 'audio', label: 'Audio', top: layout.audTop, height: layout.audH, rows: layout.audRows, dot: 'bg-sky-300', tint: 'border-sky-300/30 bg-sky-500/10' }
  ]

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
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Horizontal zoom</span>
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

      {/* Track body: fixed left gutter + horizontally-scrolling track */}
      <div className="flex min-h-0 flex-1">
        {clips.length > 0 && (
          <div
            className="relative shrink-0 overflow-hidden border-r border-white/10 bg-zinc-900/50"
            style={{ width: GUTTER }}
          >
            <div
              ref={gutterInnerRef}
              className="absolute inset-x-0 top-0 will-change-transform"
              style={{ height: layout.totalH }}
            >
              {/* Corner above the lanes, aligned with the ruler strip */}
              <div
                className="absolute inset-x-0 top-0 flex items-center border-b border-white/10 px-2"
                style={{ height: layout.clipsTop }}
              >
                <span className="text-[8px] font-semibold uppercase tracking-wider text-zinc-600">
                  Tracks
                </span>
              </div>
              {laneMeta.map(({ key, label, top, height, rows, dot, tint }) => (
                <div
                  key={key}
                  onPointerDown={collapsed[key] ? undefined : (e) => startLaneResize(e, key, rows)}
                  onDoubleClick={() => toggleCollapse(key)}
                  title={`${label} lane${collapsed[key] ? '' : ' — drag to resize'} · double-click to ${collapsed[key] ? 'expand' : 'minimize'}`}
                  className={`absolute inset-x-1 flex select-none items-center gap-1.5 overflow-hidden rounded-md border px-1.5 ${tint} ${
                    collapsed[key] ? '' : 'cursor-row-resize'
                  }`}
                  style={{ top: top + 1, height: Math.max(0, height - 2) }}
                >
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleCollapse(key)
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={collapsed[key] ? 'Expand lane' : 'Minimize lane'}
                    className="shrink-0 text-[10px] leading-none text-zinc-400 hover:text-zinc-100"
                  >
                    {collapsed[key] ? '▸' : '▾'}
                  </button>
                  <span className={`h-2 w-2 shrink-0 rounded-sm ${dot}`} />
                  <span className="truncate text-[10px] font-medium leading-none text-zinc-200">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {clips.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            Add clips from the Library (＋ on a clip) to build your reel.
          </div>
        ) : (
          <div
            ref={trackInnerRef}
            onPointerDown={onTrackDown}
            className="relative h-full cursor-pointer"
            style={{ width: Math.max(total * pxPerSec + 24, 200), minHeight: layout.totalH }}
          >
            {/* Ruler strip (the whole track scrubs; this is just the visual band) */}
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

            {/* Clip blocks */}
            <div
              className="absolute inset-x-0 flex"
              style={{ top: layout.clipsTop, height: layout.clipsH }}
            >
              {collapsed.clips ? (
                <div className="h-full w-full bg-zinc-700/40" />
              ) : (
                clips.map((clip, i) => {
                const asset = assetById.get(clip.mediaId)
                const maxOut = asset?.probe.durationSec ?? clip.outSec
                const width = clipDuration(clip) * pxPerSec
                const selected = clip.id === selectedClipId
                return (
                  <div
                    key={clip.id}
                    onClick={() => {
                      selectClip(clip.id)
                      selectOverlay(null)
                      selectImage(null)
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
                })
              )}
            </div>

            {/* Text overlay lane */}
            <div className="absolute inset-x-0" style={{ top: layout.textTop, height: layout.textH }}>
              {collapsed.text ? (
                overlays.length > 0 && <div className="absolute inset-0 bg-violet-500/15" />
              ) : (
                overlays.map((o) => {
                const left = o.startSec * pxPerSec
                const width = Math.max(10, (o.endSec - o.startSec) * pxPerSec)
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
                    style={{ left, width, top: (overlayRows.get(o.id) ?? 0) * laneH.text, height: laneH.text - 2 }}
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
                })
              )}
            </div>

            {/* Image overlay lane */}
            <div className="absolute inset-x-0" style={{ top: layout.imgTop, height: layout.imgH }}>
              {collapsed.image ? (
                imageOverlays.length > 0 && <div className="absolute inset-0 bg-orange-500/15" />
              ) : (
                imageOverlays.map((o) => {
                const asset = assetById.get(o.mediaId)
                const left = o.startSec * pxPerSec
                const width = Math.max(10, (o.endSec - o.startSec) * pxPerSec)
                const selected = o.id === selectedImageId
                return (
                  <div
                    key={o.id}
                    onPointerDown={(e) => startImageOverlayDrag(e, o, 'move')}
                    title={asset?.fileName}
                    className={`group absolute flex cursor-move items-center gap-1 overflow-hidden rounded border pl-1 ${
                      selected ? 'border-orange-300 ring-1 ring-orange-300/50' : 'border-orange-400/40'
                    } bg-orange-500/20`}
                    style={{ left, width, top: (imageRows.get(o.id) ?? 0) * laneH.image, height: laneH.image - 2 }}
                  >
                    {asset && (
                      <img
                        src={thumbUrl(asset.id)}
                        alt=""
                        onError={(e) => (e.currentTarget.style.display = 'none')}
                        className="pointer-events-none h-full w-6 shrink-0 rounded-sm object-cover opacity-80"
                      />
                    )}
                    <span className="truncate text-[9px] font-medium text-orange-100">
                      🖼&nbsp;{asset?.fileName ?? o.mediaId}
                    </span>
                    <div
                      onPointerDown={(e) => startImageOverlayDrag(e, o, 'start')}
                      className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-orange-200/70"
                    />
                    <div
                      onPointerDown={(e) => startImageOverlayDrag(e, o, 'end')}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-orange-200/70"
                    />
                  </div>
                )
                })
              )}
            </div>

            {/* Caption lane */}
            <div className="absolute inset-x-0" style={{ top: layout.capTop, height: layout.capH }}>
              {collapsed.caption ? (
                captionSegs.length > 0 && <div className="absolute inset-0 bg-emerald-500/15" />
              ) : (
                captionSegs.map((seg) => {
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
                    style={{ left, width, top: (captionRows.get(seg.id) ?? 0) * laneH.caption, height: laneH.caption - 2 }}
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
                })
              )}
            </div>

            {/* Audio track lane (music / voiceover / extracted clip audio) */}
            <div className="absolute inset-x-0" style={{ top: layout.audTop, height: layout.audH }}>
              {collapsed.audio ? (
                audioClips.length > 0 && <div className="absolute inset-0 bg-sky-500/15" />
              ) : (
                <>
              {audioClips.length === 0 && (
                <div className="flex h-6 items-center pl-1 text-[9px] text-zinc-600">
                  ♪ No audio — add an audio file (♪ in Library) or Extract a clip&apos;s audio
                </div>
              )}
              {audioClips.map((a) => {
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
                    style={{ left, width, top: (audioRows.get(a.id) ?? 0) * laneH.audio, height: laneH.audio - 2 }}
                  >
                    {asset && (
                      <img
                        src={waveformUrl(asset.id)}
                        alt=""
                        onError={(e) => (e.currentTarget.style.display = 'none')}
                        className="pointer-events-none absolute inset-y-0 opacity-70"
                        style={{
                          // The waveform PNG spans the whole source; show only the
                          // clip's [inSec, eo] slice, scaled to fill the tile.
                          left: `${-(a.inSec / Math.max(0.01, eo - a.inSec)) * 100}%`,
                          width: `${(maxOut / Math.max(0.01, eo - a.inSec)) * 100}%`,
                          height: '100%',
                          objectFit: 'fill'
                        }}
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
                </>
              )}
            </div>

            {/* Per-lane resize handles — drag the gap below a lane to resize it */}
            {(
              [
                { key: 'clips', bottom: layout.clipsTop + layout.clipsH, rows: 1 },
                { key: 'text', bottom: layout.textTop + layout.textH, rows: layout.textRows },
                { key: 'image', bottom: layout.imgTop + layout.imgH, rows: layout.imgRows },
                { key: 'caption', bottom: layout.capTop + layout.capH, rows: layout.capRows },
                { key: 'audio', bottom: layout.audTop + layout.audH, rows: layout.audRows }
              ] as { key: LaneKey; bottom: number; rows: number }[]
            )
              .filter((h) => !collapsed[h.key])
              .map((h) => (
              <div
                key={h.key}
                onPointerDown={(e) => startLaneResize(e, h.key, h.rows)}
                title={`Drag to resize the ${h.key} lane`}
                className="group/lh absolute inset-x-0 z-30 h-1.5 cursor-row-resize"
                style={{ top: h.bottom }}
              >
                <div className="h-full w-full transition-colors group-hover/lh:bg-sky-400/50" />
              </div>
            ))}

            {/* Bottom time scale (ticks + labels) */}
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-white/10"
              style={{ top: layout.scaleTop, height: layout.scaleH }}
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
    </div>
  )
}
