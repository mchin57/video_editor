/**
 * The timeline panel: the lanes of the composition being edited, with their
 * tiles, the ruler, the playhead and the toolbar, and every timeline
 * interaction (select, move, trim, split, link, drop, scrub, zoom, lane resize).
 * Its pieces live in `components/timeline/`; the tile rules in `lib/links.ts`
 * and `lib/timeline.ts`; the checklist in docs/TIMELINE.md.
 */

import {
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { AudioClip, Layer, TimelineItemRef } from '@shared/project'
import { audioClipEnd, denoiseOverridden, effectiveOut, stabilizeOverridden, videoSpeed } from '@shared/project'
import { fxLabel } from '@shared/audioFx'
import { hasSpeedRamp, sortedRamp } from '@shared/speed'
import { assetAspect, assetKind } from '@shared/media'
import { layerLabel, makeImageLayer, visualDuration } from '@shared/layers'
import { useLibrary } from '@/hooks/useMedia'
import { activeComp, getActiveComp, getFormat, useProject } from '@/state/projectStore'
import { useEditor } from '@/state/store'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import { layoutLanes, packRows, resizeRowH, rowCount } from '@/lib/lanes'
import { useDragDepth } from '@/lib/dragDepth'
import {
  canLinkItems,
  canSplitItems,
  canUnlinkItems,
  snapToPreviousDelta,
  layerLane,
  audioLane,
  refKey,
  refKeys,
  timelineTiles,
  type SourceDuration
} from '@/lib/links'
import { edgeAutoScroll, startPointerDrag } from '@/lib/pointerDrag'
import { snap } from '@/lib/snap'
import { formatTick, niceTimeStep, scaleTicks } from '@/lib/timescale'
import { waveformUrl } from '@/ipc/client'
import { MENU_SEPARATOR, useContextMenu, type ContextMenuEntry } from '@/components/ui'
import { levelOf } from '@shared/volumeLevels'
import { clamp } from '@shared/math'
import { kindInfo, layerMediaId } from '@shared/layerKinds'
import { newId } from '@shared/ids'
import {
  HOOK_SEC,
  SNAP_PX,
  RULER_H,
  ROW_H,
  MIN_ROW_H,
  MAX_ROW_H,
  SCALE_H,
  DND_MIME,
  EMPTY_LAYERS,
  EMPTY_CAPTIONS,
  EMPTY_SCRIPT,
  EMPTY_AUDIO,
  EMPTY_LEVELS,
  LANE_STYLE,
  LaneKey,
  LANE_GEOM
} from './timeline/constants'
import { spanOf, packAudioRows, snapTargetsFor } from './timeline/geometry'
import { PoseBadge, TileThumb } from './timeline/parts'
import { TileDescription } from './timeline/TileDescription'
import { TimelineToolbar } from './timeline/TimelineToolbar'
import { LaneGutter } from './timeline/LaneGutter'
import { useTileDrags } from './timeline/useTileDrags'
import {
  useGutterSync,
  usePlayheadFollow,
  useScrollPins,
  useTileDescriptionHover,
  useTimelineView,
  useWheelZoom
} from './timeline/hooks'
import { useLatest } from '@/hooks/useLatest'

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
  const selKeys = useMemo(() => refKeys(selection), [selection])
  const isSelected = (kind: TimelineItemRef['kind'], id: string): boolean => selKeys.has(refKey({ kind, id }))

  const addLayer = useProject((s) => s.addLayer)
  const addVideoLayer = useProject((s) => s.addVideoLayer)
  const addAudioClip = useProject((s) => s.addAudioClip)
  const removeItems = useProject((s) => s.removeItems)
  const splitItemsAt = useProject((s) => s.splitItemsAt)
  const snapItemsToPrevious = useProject((s) => s.snapItemsToPrevious)
  const linkItems = useProject((s) => s.linkItems)
  const unlinkItems = useProject((s) => s.unlinkItems)

  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)
  const setPlaying = usePlayback((s) => s.setPlaying)
  const setTime = usePlayback((s) => s.setTime)

  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const { descHover, descAsset, descHoverProps } = useTileDescriptionHover(assetById)

  const selectedLibId = useEditor((s) => s.selectedId)
  const previewAsset = layers.length === 0 && selectedLibId ? assetById.get(selectedLibId) : undefined
  const previewDur = previewAsset?.proxyReady ? previewAsset.probe.durationSec : 0
  const canPlay = layers.length > 0 || previewDur > 0

  const {
    pxPerSec,
    setPxPerSec,
    pxPerSecRef,
    followMode,
    setFollowMode,
    followModeRef,
    laneView,
    patchLane,
    toggleLaneCollapsed
  } = useTimelineView()
  const playingRef = useLatest(playing)

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
  const { resizeFloorH, setResizeFloorH, dragFloorW, startEdgeScrollX } = useScrollPins(naturalW)

  // Group the unified stack into typed lanes (a visual grouping only).
  // Compound clips are clip-like, so they ride in the Clips lane.
  const grouped = useMemo(() => {
    const video = layers.filter((l) => layerLane(l) === 'clips')
    const layout = layers.filter((l) => layerLane(l) === 'layout')
    const text = layers.filter((l) => layerLane(l) === 'text')
    const image = layers.filter((l) => layerLane(l) === 'image')
    const graphics = layers.filter((l) => layerLane(l) === 'graphics')
    return {
      video,
      layout,
      text,
      image,
      graphics,
      vRows: packRows(video.map(spanOf)),
      lRows: packRows(layout.map(spanOf)),
      tRows: packRows(text.map(spanOf)),
      iRows: packRows(image.map(spanOf)),
      gRows: packRows(graphics.map(spanOf))
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
  // Graphics and Captions only when present, Audio always.
  const laneDefs = [
    { key: 'clips' as const, label: 'Clips', rows: rowCount(grouped.vRows) },
    // Layout lane only when a layout exists (rare enough not to burn a band).
    ...(grouped.layout.length > 0 ? [{ key: 'layout' as const, label: 'Layout', rows: rowCount(grouped.lRows) }] : []),
    { key: 'text' as const, label: 'Text', rows: rowCount(grouped.tRows) },
    { key: 'image' as const, label: 'Image', rows: rowCount(grouped.iRows) },
    // Graphics (shapes + telestrator marks) only once a tile exists: nothing
    // drops onto it — tiles come from Insert ▸ Graphics.
    ...(grouped.graphics.length > 0
      ? [{ key: 'graphics' as const, label: 'Graphics', rows: rowCount(grouped.gRows) }]
      : []),
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

  useWheelZoom(scrollRef, pxPerSecRef, setPxPerSec, followModeRef, playingRef)
  usePlayheadFollow(scrollRef, time, playing, followMode, pxPerSec)
  useGutterSync(scrollRef, gutterInnerRef)

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

  const { startTileDrag, startLayerDrag, startCaptionDrag, startAudioDrag } = useTileDrags({
    scrollRef,
    pxPerSec,
    collectSnapTargets,
    snapSec,
    startEdgeScrollX,
    srcDur,
    assetById,
    selection,
    selKeys
  })

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

  // Render one layer block within its lane.
  const layerBlock = (
    l: Layer,
    laneKey: 'clips' | 'layout' | 'text' | 'image' | 'graphics',
    rows: Map<string, number>
  ): JSX.Element => {
    const left = l.startSec * pxPerSec
    const width = Math.max(12, (l.endSec - l.startSec) * pxPerSec)
    const selected = isSelected('layer', l.id)
    const linked = isLinkedTile(l.linkGroupId)
    const mediaId = layerMediaId(l.content)
    const asset = mediaId ? assetById.get(mediaId) : undefined
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
            {linked ? '🔗' : kindInfo(l).icon}
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
          {l.content.kind === 'video' && <PoseBadge layerId={l.id} content={l.content} />}
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
      <TimelineToolbar
        canPlay={canPlay}
        durationSec={Math.max(total, previewDur)}
        link={{ run: linkSelected, enabled: canLink }}
        unlink={{ run: unlinkSelected, enabled: canUnlink }}
        split={{ run: splitSelected, enabled: canSplit }}
        snapToPrevious={{ run: snapSelectedToPrevious, enabled: canSnapPrev }}
        remove={{ run: deleteSelected, enabled: canDelete }}
        followMode={followMode}
        setFollowMode={setFollowMode}
        setPxPerSec={setPxPerSec}
      />

      <div className="flex min-h-0 flex-1">
        <LaneGutter
          lanes={lanes}
          totalH={totalH}
          gutterRef={gutterInnerRef}
          captionsGlobalSelected={captionsGlobalSelected}
          onCaptionLanePress={selectCaptionsGlobal}
          onResizeStart={startLaneResize}
          onToggleCollapsed={toggleLaneCollapsed}
        />

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
            {!laneCollapsed('graphics') && grouped.graphics.map((l) => layerBlock(l, 'graphics', grouped.gRows))}

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
                Drag media here, or use ＋ Playhead / ＋ End on a library clip.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
