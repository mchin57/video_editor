import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type {
  AudioClip,
  CaptionSegment,
  Composition,
  Layer,
  Project,
  ScriptLine,
  TimelineItemRef,
  VolumeLevel
} from '@shared/project'
import { audioClipEnd, denoiseOverridden, effectiveOut, stabilizeOverridden, videoSpeed } from '@shared/project'
import { fxLabel } from '@shared/audioFx'
import { hasSpeedRamp, sortedRamp, sourceAfterPlayed } from '@shared/speed'
import { assetAspect, assetKind, type MediaAsset } from '@shared/media'
import { layerLabel, makeImageLayer, makeTextLayer, visualDuration } from '@shared/layers'
import { createPortal } from 'react-dom'
import { useLibrary } from '@/hooks/useMedia'
import { useHoverGuard, useHoverIntent } from '@/hooks/useHoverIntent'
import { interactionOpen } from '@/lib/interaction'
import type { HoverIntent } from '@/lib/hoverIntent'
import { DescriptionBox } from '@/components/DescriptionBox'
import { activeComp, getActiveComp, getFormat, useProject } from '@/state/projectStore'
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
import { CompBreadcrumb } from '@/components/CompBreadcrumb'
import {
  canLinkItems,
  canSplitItems,
  canUnlinkItems,
  expandGroup,
  expandSelection,
  moveItemsBy,
  snapToPreviousDelta,
  layerLane,
  audioLane,
  type TileLane,
  refKey,
  refKeys,
  tileOf,
  timelineTiles,
  trimItemsBy,
  type SourceDuration
} from '@/lib/links'
import { edgeAutoScroll, startPointerDrag } from '@/lib/pointerDrag'
import { trimVideoEnd, trimVideoStart } from '@/lib/timeline'
import { snap } from '@/lib/snap'
import { makeCaption } from '@/lib/captions'
import { formatTick, niceTimeStep, scaleTicks } from '@/lib/timescale'
import { thumbUrl, waveformUrl } from '@/ipc/client'
import { MENU_SEPARATOR, useContextMenu, type ContextMenuEntry } from '@/components/ui'
import { levelOf } from '@shared/volumeLevels'
import { clamp } from '@shared/math'
import { enumPref, numberPref, objectPref } from '@/lib/persisted'
import { usePersistedState } from '@/hooks/usePersistedState'
import { newId } from '@shared/ids'

const DEFAULT_PPS = 48
const HOOK_SEC = 3
const SNAP_PX = 7
/** Pointer slop (px) below which a press+release counts as a click, not a drag. */
const CLICK_SLOP = 2
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
const EMPTY_LEVELS: VolumeLevel[] = []

const spanOf = (l: { id: string; startSec: number; endSec: number }): Span => ({
  id: l.id,
  startSec: l.startSec,
  endSec: l.endSec
})

/**
 * A layer tile's thumbnail. Hidden while it can't load — but only for the asset
 * data it failed for: the next library refresh (new object) tries again, so a
 * tile drawn a moment before its thumb existed doesn't stay blank for good.
 */
/** Row packing for an audio band (a whole-source clip ends at its source's length). */
function packAudioRows(clips: AudioClip[], assetById: Map<string, MediaAsset>): Map<string, number> {
  return packRows(
    clips.map((a) => ({
      id: a.id,
      startSec: a.startSec,
      endSec: audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)
    }))
  )
}

/** Snap targets: layer + audio boundaries, 0 and the end. `skip` (ref keys)
 *  drops the tiles currently being dragged, so a moving group never snaps to
 *  its own members. */
function snapTargetsFor(
  layers: Layer[],
  audioClips: AudioClip[],
  assetById: Map<string, MediaAsset>,
  total: number,
  skip?: Set<string>
): number[] {
  const t = new Set<number>([0, total])
  for (const l of layers) {
    if (skip?.has(refKey({ kind: 'layer', id: l.id }))) continue
    t.add(l.startSec)
    t.add(l.endSec)
  }
  for (const a of audioClips) {
    if (skip?.has(refKey({ kind: 'audio', id: a.id }))) continue
    t.add(a.startSec)
    t.add(audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec))
  }
  return [...t]
}

function TileThumb({ asset }: { asset: MediaAsset }): JSX.Element | null {
  const [failedFor, setFailedFor] = useState<MediaAsset | null>(null)
  if (failedFor === asset) return null
  return (
    <img
      src={thumbUrl(asset)}
      alt=""
      onError={() => setFailedFor(asset)}
      className="pointer-events-none h-full w-6 shrink-0 rounded-sm object-cover opacity-80"
    />
  )
}

/** Where a hovered media tile (video, image, audio) is, for its description box. */
interface TileDescriptionAt {
  mediaId: string
  /** The tile itself (a member of the hover group) and where it was on entering. */
  el: HTMLElement
  rect: DOMRect
  /** Cursor x on entering: the box centres there, so moving straight up reaches it. */
  x: number
}

/**
 * The hovered media tile's clip description, floating just above the tile
 * (below it when there's no room) and editable in place (`DescriptionBox`). Tile,
 * box and the bridge over the gap form one hover group (`HoverIntent`), so the
 * cursor can travel from the tile up into the box; typing pins it open.
 * Portaled: the timeline's scroll area would clip it.
 */
function TileDescription({
  asset,
  at,
  intent
}: {
  asset: MediaAsset
  at: TileDescriptionAt
  intent: HoverIntent<TileDescriptionAt>
}): JSX.Element {
  const W = 260
  const GAP = 6
  const ROOM = 120 // about the box's height
  const left = Math.max(8, Math.min(at.x - W / 2, window.innerWidth - W - 8))
  const below = at.rect.top - GAP - ROOM < 8
  const box = below ? { top: at.rect.bottom + GAP } : { bottom: window.innerHeight - at.rect.top + GAP }
  // The bridge overlaps the tile and the box by a pixel so the crossing never reads as a leave.
  const bridgeTop = below ? at.rect.bottom - 1 : at.rect.top - GAP - 1
  const group = { onMouseEnter: () => intent.enter(), onMouseLeave: () => intent.leave() }
  const boxRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<HTMLDivElement>(null)
  useHoverGuard({ enter: () => intent.enter(), leave: () => intent.leave() }, () => [
    at.el,
    boxRef.current,
    bridgeRef.current
  ])
  return createPortal(
    <>
      <div
        ref={bridgeRef}
        data-description-panel
        style={{ position: 'fixed', left, width: W, top: bridgeTop, height: GAP + 2 }}
        className="z-[499]"
        {...group}
      />
      <div
        ref={boxRef}
        data-testid="timeline-description"
        data-description-panel
        style={{ position: 'fixed', left, width: W, ...box }}
        className="z-[500] rounded-lg border border-white/15 bg-zinc-900/95 p-2 shadow-2xl"
        {...group}
      >
        <div className="mb-1 truncate text-[10px] font-semibold text-zinc-400" title={asset.fileName}>
          {asset.fileName}
        </div>
        <DescriptionBox
          asset={asset}
          rows={3}
          onFocusChange={(on) => intent.pin(on, !!boxRef.current?.matches(':hover'))}
        />
      </div>
    </>,
    document.body
  )
}

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
// grouping over the unified layer stack). Keyed by `TileLane`, and the
// `satisfies` makes that exhaustive: adding a band to the tile model without
// giving it colours here is a compile error, so the two can't drift apart.
const LANE_STYLE = {
  clips: {
    dot: 'bg-sky-400',
    tint: 'border-sky-400/30 bg-sky-500/10',
    block: 'border-sky-400/40 bg-sky-500/20',
    sel: 'border-sky-300 ring-1 ring-sky-300/50'
  },
  layout: {
    dot: 'bg-fuchsia-400',
    tint: 'border-fuchsia-400/30 bg-fuchsia-500/10',
    block: 'border-fuchsia-400/40 bg-fuchsia-500/20',
    sel: 'border-fuchsia-300 ring-1 ring-fuchsia-300/50'
  },
  text: {
    dot: 'bg-violet-400',
    tint: 'border-violet-400/30 bg-violet-500/10',
    block: 'border-violet-400/40 bg-violet-500/20',
    sel: 'border-violet-300 ring-1 ring-violet-300/50'
  },
  image: {
    dot: 'bg-orange-400',
    tint: 'border-orange-400/30 bg-orange-500/10',
    block: 'border-orange-400/40 bg-orange-500/20',
    sel: 'border-orange-300 ring-1 ring-orange-300/50'
  },
  caption: {
    dot: 'bg-emerald-400',
    tint: 'border-emerald-400/30 bg-emerald-500/10',
    block: 'border-emerald-400/40 bg-emerald-500/25',
    sel: 'border-emerald-300 ring-1 ring-emerald-300/50'
  },
  audio: {
    dot: 'bg-sky-300',
    tint: 'border-sky-300/30 bg-sky-500/10',
    block: 'border-sky-400/40 bg-sky-500/15',
    sel: 'border-sky-300 ring-1 ring-sky-300/50'
  },
  fx: {
    dot: 'bg-teal-300',
    tint: 'border-teal-300/30 bg-teal-500/10',
    block: 'border-teal-400/40 bg-teal-500/15',
    sel: 'border-teal-300 ring-1 ring-teal-300/50'
  }
} as const satisfies Record<TileLane, { dot: string; tint: string; block: string; sel: string }>

type LaneKey = TileLane

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

/** How the track scroll tracks the playhead during playback: stay put, jump a
 *  page when the playhead exits the view (DAW default), or keep it centered.
 *  A view preference like zoom, so it lives in localStorage. */
type FollowMode = 'none' | 'page' | 'centered'

const FOLLOW_OPTIONS: { mode: FollowMode; label: string; title: string }[] = [
  { mode: 'none', label: 'Off', title: 'Timeline stays where you scrolled it during playback' },
  { mode: 'page', label: 'Page', title: 'Jump forward a page when the playhead reaches the right edge' },
  { mode: 'centered', label: 'Center', title: 'Continuously scroll to keep the playhead centered' }
]

// View preferences (lib/persisted.ts): zoom, follow mode, per-lane sizes.
const PPS_PREF = numberPref(DEFAULT_PPS, 8, 240)
const FOLLOW_PREF = enumPref<FollowMode>(['none', 'page', 'centered'], 'none')
const VIEW_PREF = objectPref<TimelineView>(() => ({}))

export function Timeline(): JSX.Element {
  // The timeline renders the ACTIVE composition (the root, or the nested comp
  // being edited); only the script markers are root-scoped.
  const comp = useProject(activeComp)
  const project = useProject((s) => s.project)
  const layers = comp?.layers ?? EMPTY_LAYERS
  const captionSegs = comp?.captions.enabled ? comp.captions.segments : EMPTY_CAPTIONS
  const audioClips = comp?.audioClips ?? EMPTY_AUDIO
  const script = project?.script ?? EMPTY_SCRIPT
  const volumeLevels = project?.volumeLevels ?? EMPTY_LEVELS

  const selectLayer = useUi((s) => s.selectLayer)
  const selectAudio = useUi((s) => s.selectAudio)
  const selectTile = useUi((s) => s.selectTile)
  const captionsGlobalSelected = useUi((s) => s.captionsGlobalSelected)
  const selectCaptionsGlobal = useUi((s) => s.selectCaptionsGlobal)
  // The FULL selection (a link group, or a Ctrl-click multi-selection). Every
  // tile in it highlights and moves together; `selected*Id` is just the primary.
  const selection = useUi((s) => s.selection)
  const selectItems = useUi((s) => s.selectItems)
  const selKeys = useMemo(() => refKeys(selection), [selection])
  const isSelected = (kind: TimelineItemRef['kind'], id: string): boolean => selKeys.has(refKey({ kind, id }))

  const addLayer = useProject((s) => s.addLayer)
  const addCaption = useProject((s) => s.addCaption)
  const selectCaption = useUi((s) => s.selectCaption)
  const addVideoLayer = useProject((s) => s.addVideoLayer)
  const addAudioClip = useProject((s) => s.addAudioClip)
  const removeItems = useProject((s) => s.removeItems)
  const splitItemsAt = useProject((s) => s.splitItemsAt)
  const snapItemsToPrevious = useProject((s) => s.snapItemsToPrevious)
  const linkItems = useProject((s) => s.linkItems)
  const unlinkItems = useProject((s) => s.unlinkItems)
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

  // Hovering a media tile (video, image, audio) shows its clip's description above
  // it (TileDescription). A short open delay, so sweeping across tiles doesn't
  // flash a box over each.
  const descHover = useHoverIntent<TileDescriptionAt>({ openMs: 400 })
  /** The hover wiring for a tile showing library clip `asset` (none without one). */
  const descHoverProps = (asset: MediaAsset | undefined): Partial<JSX.IntrinsicElements['div']> =>
    asset
      ? {
          // A press (select, drag, trim) closes it.
          onPointerDownCapture: () => descHover.intent.close(),
          onMouseEnter: (e) => {
            // Not mid-drag (any drag: a tile, a trim, the playhead).
            if (interactionOpen()) return
            const el = e.currentTarget
            descHover.intent.enter({ mediaId: asset.id, el, rect: el.getBoundingClientRect(), x: e.clientX })
          },
          onMouseLeave: () => descHover.intent.leave()
        }
      : {}
  const descAsset = descHover.target ? assetById.get(descHover.target.mediaId) : undefined
  // The tiles move under a scroll or zoom: drop the box rather than leave it floating.
  // A wheel inside the box scrolls its text instead (the box is portaled, so the
  // tiles don't move under it); it closes only when the mouse leaves.
  useEffect(() => {
    if (!descHover.target) return undefined
    const close = (): void => descHover.intent.close()
    const onWheel = (e: WheelEvent): void => {
      if (e.target instanceof Element && e.target.closest('[data-description-panel]')) return
      close()
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [descHover.target, descHover.intent])

  const selectedLibId = useEditor((s) => s.selectedId)
  const previewAsset = layers.length === 0 && selectedLibId ? assetById.get(selectedLibId) : undefined
  const previewDur = previewAsset?.proxyReady ? previewAsset.probe.durationSec : 0
  const canPlay = layers.length > 0 || previewDur > 0

  const [pxPerSec, setPxPerSec] = usePersistedState('timelinePps', PPS_PREF)
  const pxPerSecRef = useRef(pxPerSec)
  pxPerSecRef.current = pxPerSec

  const [followMode, setFollowMode] = usePersistedState('timelineFollow', FOLLOW_PREF)
  const followModeRef = useRef(followMode)
  followModeRef.current = followMode
  const playingRef = useRef(playing)
  playingRef.current = playing

  // Per-lane height / collapse prefs, persisted across reloads.
  const [laneView, setLaneView] = usePersistedState('timelineView', VIEW_PREF)
  const patchLane = (key: LaneKey, patch: LaneViewPref): void =>
    setLaneView((v) => ({ ...v, [key]: { ...v[key], ...patch } }))
  const toggleLaneCollapsed = (key: LaneKey): void =>
    setLaneView((v) => ({ ...v, [key]: { ...v[key], collapsed: !v[key]?.collapsed } }))
  // While a lane resize is shrinking the track, we pin the scrollable height to
  // the tallest it reached this drag so the browser can't clamp scrollTop out
  // from under us (which would feed back into the height and run away). 0 = idle.
  const [resizeFloorH, setResizeFloorH] = useState(0)
  // The horizontal twin of `resizeFloorH`, and it exists for the same reason.
  // The track's width is derived from `total`, so dragging the RIGHTMOST tile
  // leftwards shrinks the scrollable area under the drag: the browser then
  // clamps `scrollLeft` down to the new maximum, that clamp feeds straight into
  // the drag's `dx` (which adds the live `scrollLeft`), the tile jumps further
  // left, and the width shrinks again — a runaway that reads as the edge-scroll
  // accelerating even though its rate is flat. Pinning the width breaks the loop.
  //
  // It must be a HIGH-WATER MARK maintained for the whole drag, not a snapshot
  // taken at grab time: drag right and the natural width grows past a stale
  // floor, so dragging back left without releasing is free to shrink again
  // through that band and the runaway returns. `draggingX` gates the ratchet
  // (below) and is cleared on release, when the track settles to its content.
  const [dragFloorW, setDragFloorW] = useState(0)
  const [draggingX, setDraggingX] = useState(false)

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

  // The track's width from content alone. Deliberately does NOT include
  // `dragFloorW` — the floor ratchets off this, so folding the floor back in
  // would make it feed itself and the track could only ever grow.
  const naturalW = Math.max(total * pxPerSec + 24, 200)
  // Ratchet the floor up while a horizontal drag is live, so the pin tracks the
  // widest the track has been THIS drag (drag right, then left without
  // releasing). Settles immediately: the floor only changes when `naturalW`
  // does, and re-running with an unchanged `naturalW` is a no-op.
  useEffect(() => {
    if (draggingX) setDragFloorW((f) => Math.max(f, naturalW))
  }, [draggingX, naturalW])

  // Group the unified stack into typed lanes (a visual grouping only).
  // Compound clips are clip-like, so they ride in the Clips lane.
  const grouped = useMemo(() => {
    const video = layers.filter((l) => layerLane(l) === 'clips')
    const layout = layers.filter((l) => layerLane(l) === 'layout')
    const text = layers.filter((l) => layerLane(l) === 'text')
    const image = layers.filter((l) => layerLane(l) === 'image')
    return {
      video,
      layout,
      text,
      image,
      vRows: packRows(video.map(spanOf)),
      lRows: packRows(layout.map(spanOf)),
      tRows: packRows(text.map(spanOf)),
      iRows: packRows(image.map(spanOf))
    }
  }, [layers])
  const capRows = useMemo(() => packRows(captionSegs.map(spanOf)), [captionSegs])
  // A generated effect track is an ADDITION layered over source audio, so it
  // gets its own band — sharing the Audio lane hid which clip it belongs to.
  const dryClips = useMemo(() => audioClips.filter((a) => audioLane(a) === 'audio'), [audioClips])
  const fxClips = useMemo(() => audioClips.filter((a) => audioLane(a) === 'fx'), [audioClips])
  const audRows = useMemo(() => packAudioRows(dryClips, assetById), [dryClips, assetById])
  const fxRows = useMemo(() => packAudioRows(fxClips, assetById), [fxClips, assetById])

  // Lane layout: Clips / Text / Image always show (≥1 row as drop targets),
  // Captions only when present, Audio always.
  const laneDefs = [
    { key: 'clips' as const, label: 'Clips', rows: rowCount(grouped.vRows) },
    // Layout lane only when a layout exists (rare enough not to burn a band).
    ...(grouped.layout.length > 0 ? [{ key: 'layout' as const, label: 'Layout', rows: rowCount(grouped.lRows) }] : []),
    { key: 'text' as const, label: 'Text', rows: rowCount(grouped.tRows) },
    { key: 'image' as const, label: 'Image', rows: rowCount(grouped.iRows) },
    ...(captionSegs.length > 0 ? [{ key: 'caption' as const, label: 'Captions', rows: rowCount(capRows) }] : []),
    { key: 'audio' as const, label: 'Audio', rows: rowCount(audRows) },
    ...(fxClips.length > 0 ? [{ key: 'fx' as const, label: 'FX', rows: rowCount(fxRows) }] : [])
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

  /**
   * Start the edge auto-scroller for a HORIZONTAL drag, pinning the track's
   * scrollable width for the drag's lifetime (see `dragFloorW`). Every
   * horizontal drag goes through this rather than `edgeAutoScroll` directly, so
   * none of them can re-open the shrink runaway; the vertical lane resize keeps
   * calling `edgeAutoScroll` itself and pins the HEIGHT instead. Releasing the
   * pin rides on the `stop()` every caller already runs in its `onUp`.
   */
  const startEdgeScrollX = (sc: HTMLElement, onScroll: () => void): { setX: (x: number) => void; stop: () => void } => {
    // Arm the ratchet; the effect above seeds and then maintains the floor from
    // the live content width, so it keeps up with a drag that reverses.
    setDraggingX(true)
    const s = edgeAutoScroll(sc, onScroll)
    return {
      setX: s.setX,
      stop: () => {
        s.stop()
        setDraggingX(false)
        setDragFloorW(0) // release; the track settles to its true width
      }
    }
  }

  const collectSnapTargets = (skip?: Set<string>): number[] =>
    snapTargetsFor(layers, audioClips, assetById, total, skip)
  const snapTargets = useMemo(
    () => snapTargetsFor(layers, audioClips, assetById, total),
    [layers, audioClips, assetById, total]
  )
  const snapSec = (v: number): number => snap(v, snapTargets, SNAP_PX / pxPerSec)

  /** Source duration of a library asset (0 = unknown, the convention the split
   *  helpers use) — only whole-source audio clips need it. */
  const srcDur: SourceDuration = (mediaId) => assetById.get(mediaId)?.probe.durationSec ?? 0

  // Ctrl/Cmd + scroll = horizontal zoom anchored at the cursor.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) {
        // Centered follow owns the horizontal scroll during playback — swallow
        // user horizontal wheel so it doesn't fight the auto-scroll (vertical
        // lane scrolling stays live).
        if (
          followModeRef.current === 'centered' &&
          playingRef.current &&
          (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
        ) {
          e.preventDefault()
        }
        return
      }
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
  }, [setPxPerSec]) // stable: the setter's key and codec never change

  // Playhead follow: while playing, keep the playhead in view per the selected
  // mode. Runs on every playback tick (time updates each rAF), so user scrolls
  // in centered mode are re-asserted away within a frame.
  useEffect(() => {
    if (!playing || followMode === 'none') return
    const el = scrollRef.current
    if (!el) return
    const x = time * pxPerSec
    if (followMode === 'centered') {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
    } else {
      // Page jump: playhead exits the visible span → snap it back to the left
      // edge (a page forward when it ran off the right, straight there on seeks).
      const margin = 8
      if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft) {
        el.scrollLeft = Math.max(0, x - margin)
      }
    }
  }, [time, playing, followMode, pxPerSec])

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
    const nid = newId()
    const kind = assetKind(asset)
    if (kind === 'image') {
      addLayer(
        makeImageLayer(nid, id, startSec, startSec + 3, { frame: getFormat().frame, aspect: assetAspect(asset) })
      )
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
      addVideoLayer(nid, id, startSec, asset.probe.durationSec, !!asset.probe.audio, assetAspect(asset))
      // A clip with audio lands as a LINKED pair — select the whole group.
      selectTile(getActiveComp(), { kind: 'layer', id: nid })
    }
  }
  const onDragOver = (e: ReactDragEvent): void => {
    if (!e.dataTransfer.types.includes(DND_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  /**
   * Press on ANY timeline tile (layer / caption / audio) — the one entry point
   * for selecting and moving a tile, so linked tiles behave identically in every
   * lane. Ctrl/Cmd-click toggles the tile's group in the multi-selection without
   * dragging; a plain press selects (whole group) and starts a group move.
   */
  const startTileDrag = (e: ReactPointerEvent, ref: TimelineItemRef): void => {
    e.stopPropagation()
    e.preventDefault()
    // Two snapshots: the ROOT document for commitLive (undo restores the whole
    // doc), and the ACTIVE comp for tile math — inside a nested comp the tiles
    // live there, and the group transforms must produce a comp, not a root.
    const before = useProject.getState().project
    const comp0 = getActiveComp()
    if (!before || !comp0) return
    const tile = tileOf(comp0, ref)
    if (!tile) return
    // Right button: select (unless it is already part of the selection) and
    // let the context menu open — never start a move.
    if (e.button === 2) {
      if (!selKeys.has(refKey(ref))) selectItems(expandGroup(comp0, ref), ref)
      return
    }
    if ((e.ctrlKey || e.metaKey) && tile.linkable) {
      toggleSelected(comp0, ref)
      return
    }
    setPlaying(false)
    // Grabbing something that's already part of a multi-selection drags the whole
    // set; otherwise the press selects this tile's group (or just this tile).
    const refs = selKeys.has(refKey(ref)) && selection.length > 1 ? selection : expandGroup(comp0, ref)
    selectItems(refs, ref)
    startGroupMove(e, before, comp0, refs, ref)
  }

  /** Ctrl/Cmd-click: add this tile's whole group to the selection, or drop it if
   *  it's already in there. Layout layers never join a multi-selection (they
   *  can't be linked), so they fall through to a plain select. */
  const toggleSelected = (p: Composition, ref: TimelineItemRef): void => {
    const group = expandGroup(p, ref)
    const groupKeys = refKeys(group)
    if (selKeys.has(refKey(ref))) {
      const rest = selection.filter((r) => !groupKeys.has(refKey(r)))
      if (rest.length === 0) useUi.getState().clearSelection()
      else selectItems(rest, rest[rest.length - 1])
      return
    }
    selectItems(expandSelection(p, [...selection, ...group]), ref)
  }

  /**
   * Drag the whole selection in time: ONE shared delta applied to every tile
   * (`moveItemsBy`), so relative offsets and each tile's own duration survive
   * exactly — the earliest tile clamps at 0 and the rest keep their spacing.
   * Snapping follows the tile you grabbed, with the moving tiles' own edges
   * excluded so the group can't snap to itself.
   */
  const startGroupMove = (
    e: ReactPointerEvent,
    before: Project,
    comp0: Composition,
    refs: TimelineItemRef[],
    primary: TimelineItemRef
  ): void => {
    const startSec = tileOf(comp0, primary)?.startSec ?? 0
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const targets = collectSnapTargets(refKeys(refs))
    let dragged = false
    let last: PointerEvent | null = null
    let scroller: { setX: (x: number) => void; stop: () => void } | null = null
    const onMove = (ev: PointerEvent): void => {
      last = ev
      scroller?.setX(ev.clientX)
      const dx = ev.clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)
      if (!dragged && Math.abs(dx) <= CLICK_SLOP) return // still a click, not a drag
      dragged = true
      const snapped = snap(startSec + dx / pxPerSec, targets, SNAP_PX / pxPerSec)
      // Always recomputed from the pre-drag COMP snapshot, so the delta can't
      // accumulate (and the transform yields a comp, spliced back at editPath).
      useProject.getState().liveUpdate(() => moveItemsBy(comp0, refs, snapped - startSec))
    }
    scroller = sc ? startEdgeScrollX(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      if (!dragged) {
        // Released without moving = a plain click: collapse the selection onto
        // the tile that was clicked (its group). Without this a Ctrl-built
        // multi-selection could never be narrowed back down — pressing a member
        // has to keep the whole set alive so the set can be dragged.
        const p = getActiveComp()
        if (p) selectItems(expandGroup(p, primary), primary)
        return
      }
      useProject.getState().commitLive(before)
    })
  }

  /** The tiles an edge drag applies to: the pressed tile's link group, or the
   *  whole multi-selection when the pressed tile is part of one. Same rule as a
   *  move — one tile means the single-tile trim path below. */
  const edgeRefs = (p: Composition, ref: TimelineItemRef): TimelineItemRef[] =>
    selKeys.has(refKey(ref)) && selection.length > 1 ? selection : expandGroup(p, ref)

  /**
   * Trim one edge of EVERY tile in `refs` by the same timeline delta
   * (`trimItemsBy`), so a 3s trim takes 3s off each member — each converting the
   * delta through its own speed profile / in-out points, and the group clamped to
   * what its most constrained member can give. `edge0` is the pressed tile's
   * current edge position, which is what the pointer (and snapping) follows.
   */
  const startGroupTrim = (
    e: ReactPointerEvent,
    before: Project,
    comp0: Composition,
    refs: TimelineItemRef[],
    mode: 'start' | 'end',
    edge0: number
  ): void => {
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const targets = collectSnapTargets(refKeys(refs))
    let dragged = false
    let last: PointerEvent | null = null
    let scroller: { setX: (x: number) => void; stop: () => void } | null = null
    const onMove = (ev: PointerEvent): void => {
      last = ev
      scroller?.setX(ev.clientX)
      const dx = ev.clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)
      if (!dragged && Math.abs(dx) <= CLICK_SLOP) return
      dragged = true
      const snapped = snap(edge0 + dx / pxPerSec, targets, SNAP_PX / pxPerSec)
      useProject.getState().liveUpdate(() => trimItemsBy(comp0, refs, mode, snapped - edge0, srcDur))
    }
    scroller = sc ? startEdgeScrollX(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      if (dragged) useProject.getState().commitLive(before)
    })
  }

  // Trim a layer block's left/right edge. Moving it is `startTileDrag`. A tile in
  // a link group (or a multi-selection) trims the whole set through
  // `startGroupTrim`; alone, it takes the freeze/speed-aware single-tile path.
  const startLayerDrag = (e: ReactPointerEvent, layer: Layer, mode: 'start' | 'end'): void => {
    e.stopPropagation()
    e.preventDefault()
    setPlaying(false)
    const before = useProject.getState().project
    const comp0 = getActiveComp()
    if (!before || !comp0) return
    const ref: TimelineItemRef = { kind: 'layer', id: layer.id }
    const refs = edgeRefs(comp0, ref)
    selectItems(refs, ref)
    if (refs.length > 1) {
      return startGroupTrim(e, before, comp0, refs, mode, mode === 'start' ? layer.startSec : layer.endSec)
    }
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const deltaFor = (clientX: number): number => (clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)) / pxPerSec
    const { startSec, endSec } = layer
    const srcOut =
      layer.content.kind === 'video'
        ? (assetById.get(layer.content.mediaId)?.probe.durationSec ?? layer.content.outSec)
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
          if (mode === 'start') {
            if (layer.content.kind === 'video') {
              // Freeze-aware: drops holds trimmed past and keeps the window
              // invariant (computed from the drag-start snapshot). The pointer
              // delta is PLAYED time — walk the speed profile (nonlinear under
              // a ramp) to move the source point.
              const c = layer.content
              return trimVideoStart(layer, c, clamp(sourceAfterPlayed(c, c.inSec, d), 0, c.outSec - 0.1))
            }
            return { ...l, startSec: clamp(snapSec(startSec + d), 0, l.endSec - 0.2) }
          }
          // end
          if (layer.content.kind === 'video') {
            const c = layer.content
            return trimVideoEnd(layer, c, clamp(sourceAfterPlayed(c, c.outSec, d), c.inSec + 0.1, srcOut))
          }
          return { ...l, endSec: Math.max(l.startSec + 0.2, snapSec(endSec + d)) }
        })
      }))
    }
    scroller = sc ? startEdgeScrollX(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      useProject.getState().commitLive(before)
    })
  }

  // Trim a caption block's left/right edge (moving it is `startTileDrag`).
  const startCaptionDrag = (e: ReactPointerEvent, seg: CaptionSegment, mode: 'start' | 'end'): void => {
    e.stopPropagation()
    e.preventDefault()
    const before = useProject.getState().project
    const comp0 = getActiveComp()
    if (!before || !comp0) return
    const ref: TimelineItemRef = { kind: 'caption', id: seg.id }
    const refs = edgeRefs(comp0, ref)
    selectItems(refs, ref)
    if (refs.length > 1) {
      return startGroupTrim(e, before, comp0, refs, mode, mode === 'start' ? seg.startSec : seg.endSec)
    }
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const deltaFor = (clientX: number): number => (clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)) / pxPerSec
    const { startSec, endSec } = seg
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
            if (mode === 'start') return { ...s, startSec: clamp(snapSec(startSec + d), 0, s.endSec - 0.1) }
            return { ...s, endSec: Math.max(s.startSec + 0.1, snapSec(endSec + d)) }
          })
        }
      }))
    }
    scroller = sc ? startEdgeScrollX(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      useProject.getState().commitLive(before)
    })
  }

  // Trim an audio clip's left/right edge (moving it is `startTileDrag`). The left
  // edge moves the in-point, so the clip's start follows it.
  const startAudioDrag = (e: ReactPointerEvent, clip: AudioClip, mode: 'start' | 'end', maxOut: number): void => {
    e.stopPropagation()
    e.preventDefault()
    const before = useProject.getState().project
    const comp0 = getActiveComp()
    if (!before || !comp0) return
    const { startSec, inSec } = clip
    const effOut = effectiveOut(clip, maxOut)
    const ref: TimelineItemRef = { kind: 'audio', id: clip.id }
    const refs = edgeRefs(comp0, ref)
    selectItems(refs, ref)
    if (refs.length > 1) {
      // The right edge sits at the clip's timeline end; the left edge at its start.
      const edge0 = mode === 'start' ? startSec : startSec + (effOut - inSec)
      return startGroupTrim(e, before, comp0, refs, mode, edge0)
    }
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    const deltaFor = (clientX: number): number => (clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll)) / pxPerSec
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
          if (mode === 'start') {
            const ni = clamp(inSec + d, 0, effOut - 0.1)
            return { ...a, inSec: ni, startSec: Math.max(0, startSec + (ni - inSec)) }
          }
          return { ...a, outSec: clamp(effOut + d, a.inSec + 0.1, maxOut) }
        })
      }))
    }
    scroller = sc ? startEdgeScrollX(sc, () => last && onMove(last)) : null
    startPointerDrag(onMove, () => {
      scroller?.stop()
      useProject.getState().commitLive(before)
    })
  }

  // Split / delete / link act on the WHOLE selection (a single tile, a link
  // group, or a Ctrl-built set) — one undo step each.
  const canSplit = !!comp && canSplitItems(comp, selection, time, srcDur)
  const splitSelected = (): void => splitItemsAt(selection, time, srcDur)

  const canDelete = selection.length > 0
  const deleteSelected = (): void => removeItems(selection)

  // Butting the selection against its lane's previous tile. Disabled when it is
  // already flush, so the button reflects whether pressing it would do anything.
  const canSnapPrev = !!comp && snapToPreviousDelta(comp, selection, srcDur) !== null
  const snapSelectedToPrevious = (): void => snapItemsToPrevious(selection, srcDur)

  const canLink = !!comp && canLinkItems(comp, selection)
  const canUnlink = !!comp && canUnlinkItems(comp, selection)
  const linkSelected = (): void => linkItems(selection)
  const unlinkSelected = (): void => unlinkItems(selection)
  // Group ids that actually bind two or more tiles (a leftover single-member id
  // reads as unlinked everywhere). Tiles in one can't be trimmed on their own —
  // nothing about a one-tile trim translates to the rest of the group — so their
  // edge handles aren't rendered and they show a 🔗 badge instead.
  const linkedGroups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of comp ? timelineTiles(comp) : []) {
      if (t.linkGroupId) counts.set(t.linkGroupId, (counts.get(t.linkGroupId) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([gid]) => gid))
  }, [comp])
  const isLinkedTile = (gid: string | undefined): boolean => !!gid && linkedGroups.has(gid)

  const addText = (): void => {
    const id = newId()
    const start = usePlayback.getState().time
    addLayer(makeTextLayer(id, start, start + 3, getFormat().frame))
    selectLayer(id)
  }

  /** A caption at the playhead, in the lane-wide caption style like every other. */
  const addCaptionAtPlayhead = (): void => {
    const id = newId()
    const start = usePlayback.getState().time
    addCaption(makeCaption(id, start, start + 2))
    selectCaption(id)
  }

  // Render one layer block within its lane.
  const layerBlock = (
    l: Layer,
    laneKey: 'clips' | 'layout' | 'text' | 'image',
    rows: Map<string, number>
  ): JSX.Element => {
    const left = l.startSec * pxPerSec
    const width = Math.max(12, (l.endSec - l.startSec) * pxPerSec)
    const selected = isSelected('layer', l.id)
    const linked = isLinkedTile(l.linkGroupId)
    const asset =
      l.content.kind === 'video' || l.content.kind === 'image' ? assetById.get(l.content.mediaId) : undefined
    const st = LANE_STYLE[laneKey]
    const rowH = laneRowHeight(laneKey)
    return (
      <div
        key={l.id}
        data-testid={`tile-layer-${l.id}`}
        onPointerDown={(e) => startTileDrag(e, { kind: 'layer', id: l.id })}
        {...descHoverProps(asset)}
        title={linked ? `${layerLabel(l)} · linked` : layerLabel(l)}
        className={`group absolute flex cursor-move items-start gap-1 overflow-hidden rounded border pl-1 ${
          selected ? st.sel : st.block
        } ${l.hidden ? 'opacity-40' : ''}`}
        style={{ left, width, top: laneTop(laneKey) + (rows.get(l.id) ?? 0) * rowH, height: rowH - 2 }}
      >
        {asset && <TileThumb asset={asset} />}
        {/* The title row sits top-left (every tile kind does), its badges beside it. */}
        <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-1 pr-2 pt-0.5">
          <span className="min-w-0 truncate text-[9px] font-medium leading-tight text-zinc-100">
            {linked
              ? '🔗'
              : l.content.kind === 'text'
                ? '🅣'
                : l.content.kind === 'image'
                  ? '🖼'
                  : l.content.kind === 'layout'
                    ? '▦'
                    : l.content.kind === 'compound'
                      ? '🧩'
                      : '🎬'}
            &nbsp;
            {asset?.fileName ?? layerLabel(l)}
          </span>
          {l.content.kind === 'video' && hasSpeedRamp(l.content) ? (
            <span
              className="shrink-0 rounded bg-fuchsia-500/70 px-1 text-[8px] font-bold leading-tight text-fuchsia-50"
              title={`Speed ramp (${sortedRamp(l.content)
                .map((k) => `${k.speed}×`)
                .join(' → ')})`}
            >
              ×~
            </span>
          ) : l.content.kind === 'video' && videoSpeed(l.content) !== 1 ? (
            <span
              className="shrink-0 rounded bg-fuchsia-500/70 px-1 text-[8px] font-bold leading-tight text-fuchsia-50"
              title={`Playback speed ${videoSpeed(l.content)}×`}
            >
              {videoSpeed(l.content)}×
            </span>
          ) : null}
          {l.content.kind === 'video' && stabilizeOverridden(l.content) && (
            <span
              className={`ml-auto shrink-0 rounded px-1 text-[8px] font-bold leading-tight ${
                l.content.stabilize ? 'bg-emerald-500/80 text-emerald-50' : 'bg-zinc-500/80 text-zinc-100 line-through'
              }`}
              title={`Stabilization forced ${l.content.stabilize ? 'on' : 'off'} for this clip (overrides the project default)`}
            >
              S
            </span>
          )}
        </div>
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
  }

  const isEmpty = layers.length === 0 && audioClips.length === 0

  /**
   * Right-click on an audio tile: "Add to volume level ▸" (None / each level /
   * New level…), through the shared ContextMenu. Applies to the clicked clip —
   * or, when it is part of the selection, to every selected audio clip. An
   * effect track can't join: it follows the clip it was made from.
   */
  const tileMenu = useContextMenu()
  const audioTileMenu = (a: AudioClip): ContextMenuEntry[] => {
    if (a.kind === 'fx') {
      return [
        {
          label: 'Add to volume level',
          disabled: true,
          reason: 'An effect track follows the volume level of the clip it was made from.',
          testId: 'ctx-volume-level'
        }
      ]
    }
    const levels = useProject.getState().project?.volumeLevels ?? []
    const clipsNow = getActiveComp()?.audioClips ?? []
    const sel = useUi.getState().selection
    const ids = (
      sel.some((r) => r.kind === 'audio' && r.id === a.id)
        ? sel.filter((r) => r.kind === 'audio').map((r) => r.id)
        : [a.id]
    ).filter((id) => clipsNow.find((c) => c.id === id)?.kind !== 'fx')
    const current = levelOf(a, levels)?.id ?? null
    const assign = (levelId: string | null) => (): void => useProject.getState().setClipsVolumeLevel(ids, levelId)
    return [
      {
        label: 'Add to volume level',
        testId: 'ctx-volume-level',
        submenu: [
          { label: 'None', checked: current === null, onSelect: assign(null), testId: 'ctx-level-none' },
          ...levels.map((l): ContextMenuEntry => ({
            label: `${l.name} · ${l.targetLufs} LUFS`,
            checked: current === l.id,
            onSelect: assign(l.id),
            testId: `ctx-level-${l.id}`
          })),
          MENU_SEPARATOR,
          {
            label: 'New level…',
            testId: 'ctx-level-new',
            onSelect: () => useUi.getState().setLevelDialog({ mode: 'create', assign: ids })
          }
        ]
      }
    ]
  }

  /**
   * One audio tile. Shared by the Audio lane and the FX lane so a generated
   * effect track behaves EXACTLY like the audio it sits over — same drag,
   * trim handles, selection, waveform and badges — rather than becoming a
   * second, quietly diverging implementation.
   */
  const renderAudioTile = (a: AudioClip, laneKey: 'audio' | 'fx', rows: Map<string, number>): JSX.Element => {
    const asset = assetById.get(a.mediaId)
    const maxOut = asset?.probe.durationSec ?? (a.outSec || 1)
    const eo = effectiveOut(a, maxOut)
    const left = a.startSec * pxPerSec
    const width = Math.max(12, (eo - a.inSec) * pxPerSec)
    const selected = isSelected('audio', a.id)
    const linked = isLinkedTile(a.linkGroupId)
    const rowH = laneRowHeight(laneKey)
    const fxName = a.fx ? fxLabel(a.fx.settings) : null
    const level = levelOf(a, volumeLevels)
    return (
      <div
        key={a.id}
        data-testid={`tile-audio-${a.id}`}
        onPointerDown={(e) => startTileDrag(e, { kind: 'audio', id: a.id })}
        onContextMenu={(e) => tileMenu.open(e, audioTileMenu(a))}
        {...descHoverProps(asset)}
        title={[fxName ? `${fxName} track` : null, asset?.fileName ?? a.mediaId, linked ? 'linked' : null]
          .filter(Boolean)
          .join(' · ')}
        className={`group absolute flex cursor-move items-center overflow-hidden rounded border ${
          selected ? LANE_STYLE[laneKey].sel : LANE_STYLE[laneKey].block
        }`}
        style={{ left, width, top: laneTop(laneKey) + (rows.get(a.id) ?? 0) * rowH, height: rowH - 2 }}
      >
        {asset && (
          <img
            src={waveformUrl(asset)}
            alt=""
            onError={(e) => (e.currentTarget.style.display = 'none')}
            className={`pointer-events-none absolute inset-y-0 max-w-none ${a.mute ? 'opacity-20' : 'opacity-70'}`}
            style={{
              left: `${-(a.inSec / Math.max(0.01, eo - a.inSec)) * 100}%`,
              width: `${(maxOut / Math.max(0.01, eo - a.inSec)) * 100}%`,
              height: '100%',
              objectFit: 'fill'
            }}
          />
        )}
        {/* The title row sits top-left (every tile kind does); the badges share it,
            right-aligned, so a clip carrying several doesn't stack them. */}
        <div className="pointer-events-none absolute inset-x-1.5 top-0.5 flex min-w-0 items-center gap-1">
          <span
            className={`min-w-0 truncate text-[9px] font-medium leading-tight ${
              a.mute ? 'text-zinc-400 line-through' : 'text-sky-50'
            }`}
          >
            {linked ? '🔗' : fxName ? '✧' : a.kind === 'extracted' ? '🎙' : '♪'}&nbsp;
            {fxName ?? asset?.fileName ?? a.mediaId}
          </span>
          {(a.mute || denoiseOverridden(a) || level) && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {level && (
                <span
                  data-testid={`tile-level-${a.id}`}
                  className="max-w-[6rem] truncate rounded bg-violet-500/80 px-1 text-[8px] font-bold leading-tight text-violet-50"
                  title={`In the “${level.name}” volume level (${level.targetLufs} LUFS)`}
                >
                  ◎ {level.name}
                </span>
              )}
              {a.mute && (
                <span
                  className="rounded bg-zinc-900/80 px-1 text-[8px] font-bold leading-tight text-zinc-100"
                  title="Muted — silent in the preview and left out of the export"
                >
                  🔇
                </span>
              )}
              {denoiseOverridden(a) && (
                <span
                  className={`rounded px-1 text-[8px] font-bold leading-tight ${
                    a.denoise ? 'bg-emerald-500/80 text-emerald-50' : 'bg-zinc-500/80 text-zinc-100 line-through'
                  }`}
                  title={`Noise filter forced ${a.denoise ? 'on' : 'off'} for this clip (overrides the project default)`}
                >
                  N
                </span>
              )}
            </span>
          )}
        </div>
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
  }

  return (
    <div className="flex h-full flex-col">
      {tileMenu.menu}
      {descHover.target && descAsset && (
        <TileDescription asset={descAsset} at={descHover.target} intent={descHover.intent} />
      )}
      {/* Transport / edit toolbar */}
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
          {tc(time)} / {tc(Math.max(total, previewDur))}
        </span>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <ToolbarButton
          title="Link the selected tiles so they move, split and delete together (Ctrl/Cmd-click tiles to multi-select). Layouts can't be linked."
          onClick={linkSelected}
          disabled={!canLink}
        >
          🔗 Link
        </ToolbarButton>
        <ToolbarButton
          title="Unlink the selected tiles — the whole group they belong to"
          onClick={unlinkSelected}
          disabled={!canUnlink}
        >
          ⛓ Unlink
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <ToolbarButton
          title="Split the selection at the playhead (S) — every linked tile the playhead crosses"
          onClick={splitSelected}
          disabled={!canSplit}
        >
          ✂ Split
        </ToolbarButton>
        <ToolbarButton
          title="Butt the selection against the previous clip in its lane, closing the gap (N). With nothing before it, snaps to the start."
          onClick={snapSelectedToPrevious}
          disabled={!canSnapPrev}
        >
          ⇤ Snap
        </ToolbarButton>
        <ToolbarButton title="Add a text layer at the playhead (T)" onClick={addText}>
          ＋ Text
        </ToolbarButton>
        <ToolbarButton
          title="Add a caption at the playhead, in the caption style (turns the caption lane on)"
          onClick={addCaptionAtPlayhead}
        >
          ＋ Caption
        </ToolbarButton>
        <ToolbarButton
          title="Delete the selection — every selected tile (Del)"
          onClick={deleteSelected}
          disabled={!canDelete}
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

      <div className="flex min-h-0 flex-1">
        {/* Fixed left gutter with lane labels */}
        <div
          className="relative shrink-0 overflow-hidden border-r border-white/10 bg-zinc-900/50"
          style={{ width: GUTTER }}
        >
          <div
            ref={gutterInnerRef}
            className="absolute inset-x-0 top-0 will-change-transform"
            style={{ height: totalH }}
          >
            <div
              className="absolute inset-x-0 top-0 flex items-center border-b border-white/10 px-2"
              style={{ height: RULER_H }}
            >
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
          data-testid="timeline-scroll"
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
            style={{
              width: Math.max(naturalW, dragFloorW),
              minWidth: '100%',
              minHeight: Math.max(totalH, resizeFloorH)
            }}
          >
            {/* Ruler */}
            <div
              className="absolute inset-x-0 top-0 border-b border-white/10 bg-black/30"
              style={{ height: RULER_H }}
            />

            {/* 3-second hook marker */}
            {total >= HOOK_SEC && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-amber-400/70"
                style={{ left: HOOK_SEC * pxPerSec }}
              >
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
            {!laneCollapsed('layout') && grouped.layout.map((l) => layerBlock(l, 'layout', grouped.lRows))}
            {!laneCollapsed('text') && grouped.text.map((l) => layerBlock(l, 'text', grouped.tRows))}
            {!laneCollapsed('image') && grouped.image.map((l) => layerBlock(l, 'image', grouped.iRows))}

            {/* Caption lane */}
            {!laneCollapsed('caption') &&
              captionSegs.map((seg) => {
                const left = seg.startSec * pxPerSec
                const width = Math.max(10, (seg.endSec - seg.startSec) * pxPerSec)
                const selected = isSelected('caption', seg.id)
                const linked = isLinkedTile(seg.linkGroupId)
                const rowH = laneRowHeight('caption')
                return (
                  <div
                    key={seg.id}
                    data-testid={`tile-caption-${seg.id}`}
                    onPointerDown={(e) => startTileDrag(e, { kind: 'caption', id: seg.id })}
                    title={linked ? `${seg.text} · linked` : seg.text}
                    className={`group absolute flex cursor-move items-start overflow-hidden rounded border px-1.5 pt-0.5 ${
                      selected
                        ? LANE_STYLE.caption.sel
                        : seg.enabled
                          ? LANE_STYLE.caption.block
                          : 'border-zinc-500/40 bg-zinc-600/30'
                    }`}
                    style={{
                      left,
                      width,
                      top: laneTop('caption') + (capRows.get(seg.id) ?? 0) * rowH,
                      height: rowH - 2
                    }}
                  >
                    <span className="truncate text-[9px] font-medium leading-tight text-emerald-100">
                      {linked ? '🔗' : 'CC'}&nbsp;&nbsp;{seg.text}
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

            {/* Audio lane — source audio only; effect tracks get their own band. */}
            {!laneCollapsed('audio') && dryClips.map((a) => renderAudioTile(a, 'audio', audRows))}

            {/* FX lane — generated echo/chorus tracks layered over the audio. */}
            {!laneCollapsed('fx') && fxClips.map((a) => renderAudioTile(a, 'fx', fxRows))}

            {/* Bottom time scale */}
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-white/10"
              style={{ top: scaleTop, height: SCALE_H }}
            >
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
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-rose-400"
              style={{ left: time * pxPerSec }}
            >
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
