/**
 * Timeline ▸ pressing and dragging tiles: select (Ctrl/Cmd-click to build a
 * multi-selection), move the selection, and trim an edge — of a whole link
 * group / selection through `trimItemsBy`, or of a lone tile through its own
 * freeze- and speed-aware path — and set a freeze's hold from its overlay's
 * edge. Every drag is one undo step (`commitLive`) and
 * works from its press-time snapshot. The tile rules live in `lib/links.ts`
 * and `lib/timeline.ts`; e2e: link, freezeTrim, timelineInteractions,
 * edgeScrollShrink, keybinds.
 */

import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { AudioClip, CaptionSegment, Composition, Layer, Project, TimelineItemRef } from '@shared/project'
import { effectiveOut } from '@shared/project'
import { freezeSpans } from '@shared/layers'
import type { MediaAsset } from '@shared/media'
import { sourceAfterPlayed } from '@shared/speed'
import { clamp } from '@shared/math'
import { getActiveComp, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { useUi } from '@/state/ui'
import {
  expandGroup,
  expandSelection,
  moveItemsBy,
  refKey,
  refKeys,
  tileOf,
  trimItemsBy,
  type SourceDuration
} from '@/lib/links'
import { startPointerDrag } from '@/lib/pointerDrag'
import { setFreezeHold, trimVideoEndBy, trimVideoStart } from '@/lib/timeline'
import { snap } from '@/lib/snap'
import { shiftMarks } from '@shared/graphics'
import { CLICK_SLOP, SNAP_PX } from './constants'

export interface TileDragDeps {
  scrollRef: RefObject<HTMLDivElement | null>
  pxPerSec: number
  /** Snap targets, without the tiles in `skip` (ref keys). */
  collectSnapTargets: (skip?: Set<string>) => number[]
  /** Snap a timeline second to the current targets. */
  snapSec: (v: number) => number
  /** The horizontal edge auto-scroller with the width pin (`useScrollPins`). */
  startEdgeScrollX: (sc: HTMLElement, onScroll: () => void) => { setX: (x: number) => void; stop: () => void }
  srcDur: SourceDuration
  assetById: Map<string, MediaAsset>
  /** The current selection and its ref keys. */
  selection: TimelineItemRef[]
  selKeys: Set<string>
}

export function useTileDrags({
  scrollRef,
  pxPerSec,
  collectSnapTargets,
  snapSec,
  startEdgeScrollX,
  srcDur,
  assetById,
  selection,
  selKeys
}: TileDragDeps): {
  startTileDrag: (e: ReactPointerEvent, ref: TimelineItemRef, onClick?: () => void) => void
  startLayerDrag: (e: ReactPointerEvent, layer: Layer, mode: 'start' | 'end') => void
  startCaptionDrag: (e: ReactPointerEvent, seg: CaptionSegment, mode: 'start' | 'end') => void
  startAudioDrag: (e: ReactPointerEvent, clip: AudioClip, mode: 'start' | 'end', maxOut: number) => void
  startFreezeDrag: (e: ReactPointerEvent, layer: Layer, index: number) => void
} {
  const selectItems = useUi((s) => s.selectItems)
  const setPlaying = usePlayback((s) => s.setPlaying)

  /**
   * Follow a horizontal drag from the press `e`: `onMove(dxPx)` gets the
   * pointer's travel in px, plus any edge auto-scroll since the press (so a
   * drag past the track's edge keeps going); `onUp()` runs on release. The
   * scroller pins the track's width for the drag (`startEdgeScrollX`).
   */
  const trackHorizontalDrag = (e: ReactPointerEvent, onMove: (dxPx: number) => void, onUp: () => void): void => {
    const startX = e.clientX
    const sc = scrollRef.current
    const startScroll = sc?.scrollLeft ?? 0
    let last: PointerEvent | null = null
    let scroller: { setX: (x: number) => void; stop: () => void } | null = null
    const move = (ev: PointerEvent): void => {
      last = ev
      scroller?.setX(ev.clientX)
      onMove(ev.clientX - startX + ((sc?.scrollLeft ?? 0) - startScroll))
    }
    scroller = sc ? startEdgeScrollX(sc, () => last && move(last)) : null
    startPointerDrag(move, () => {
      scroller?.stop()
      onUp()
    })
  }

  /**
   * Press on ANY timeline tile (layer / caption / audio) — the one entry point
   * for selecting and moving a tile, so linked tiles behave identically in every
   * lane. Ctrl/Cmd-click toggles the tile's group in the multi-selection without
   * dragging; a plain press selects (whole group) and starts a group move.
   * `onClick` runs when the press is released without dragging (after the
   * selection collapses onto the tile) — a freeze overlay picks itself there.
   */
  const startTileDrag = (e: ReactPointerEvent, ref: TimelineItemRef, onClick?: () => void): void => {
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
    startGroupMove(e, before, comp0, refs, ref, onClick)
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
    primary: TimelineItemRef,
    onClick?: () => void
  ): void => {
    const startSec = tileOf(comp0, primary)?.startSec ?? 0
    const targets = collectSnapTargets(refKeys(refs))
    let dragged = false
    trackHorizontalDrag(
      e,
      (dx) => {
        if (!dragged && Math.abs(dx) <= CLICK_SLOP) return // still a click, not a drag
        dragged = true
        const snapped = snap(startSec + dx / pxPerSec, targets, SNAP_PX / pxPerSec)
        // Always recomputed from the pre-drag COMP snapshot, so the delta can't
        // accumulate (and the transform yields a comp, spliced back at editPath).
        useProject.getState().liveUpdate(() => moveItemsBy(comp0, refs, snapped - startSec))
      },
      () => {
        if (!dragged) {
          // Released without moving = a plain click: collapse the selection onto
          // the tile that was clicked (its group). Without this a Ctrl-built
          // multi-selection could never be narrowed back down — pressing a member
          // has to keep the whole set alive so the set can be dragged.
          const p = getActiveComp()
          if (p) selectItems(expandGroup(p, primary), primary)
          onClick?.()
          return
        }
        useProject.getState().commitLive(before)
      }
    )
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
    const targets = collectSnapTargets(refKeys(refs))
    let dragged = false
    trackHorizontalDrag(
      e,
      (dx) => {
        if (!dragged && Math.abs(dx) <= CLICK_SLOP) return
        dragged = true
        const snapped = snap(edge0 + dx / pxPerSec, targets, SNAP_PX / pxPerSec)
        useProject.getState().liveUpdate(() => trimItemsBy(comp0, refs, mode, snapped - edge0, srcDur))
      },
      () => {
        if (dragged) useProject.getState().commitLive(before)
      }
    )
  }

  /** One undo step for a single-tile trim, however it went. */
  const commitFrom = (before: Project) => (): void => useProject.getState().commitLive(before)

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
    const { startSec, endSec } = layer
    const srcOut =
      layer.content.kind === 'video'
        ? (assetById.get(layer.content.mediaId)?.probe.durationSec ?? layer.content.outSec)
        : 0
    trackHorizontalDrag(
      e,
      (dx) => {
        const d = dx / pxPerSec
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
              const ns = clamp(snapSec(startSec + d), 0, l.endSec - 0.2)
              // Graphics marks are timed from the start: re-base them (from the
              // drag-start snapshot) so each keeps its moment on the clip.
              if (layer.content.kind === 'graphics') {
                return {
                  ...l,
                  startSec: ns,
                  content: { ...layer.content, marks: shiftMarks(layer.content.marks, ns - layer.startSec) }
                }
              }
              return { ...l, startSec: ns }
            }
            // end
            if (layer.content.kind === 'video') {
              // Walks back through the footage AND freeze holds as played time
              // (into a freeze: cut past it, then shorten the hold).
              return trimVideoEndBy(layer, layer.content, d, srcOut)
            }
            return { ...l, endSec: Math.max(l.startSec + 0.2, snapSec(endSec + d)) }
          })
        }))
      },
      commitFrom(before)
    )
  }

  /**
   * Drag a freeze overlay's right edge: sets that hold's length (`setFreezeHold`,
   * at least MIN_HOLD_SEC), moving only this clip's end. The edge snaps like any
   * other, to targets outside this clip. Picks the freeze, so Delete removes it.
   */
  const startFreezeDrag = (e: ReactPointerEvent, layer: Layer, index: number): void => {
    e.stopPropagation()
    e.preventDefault()
    setPlaying(false)
    const before = useProject.getState().project
    const comp0 = getActiveComp()
    if (!before || !comp0 || layer.content.kind !== 'video') return
    const c = layer.content
    const span = freezeSpans(c, layer).find((s) => s.index === index)
    if (!span) return
    const ref: TimelineItemRef = { kind: 'layer', id: layer.id }
    selectItems(expandGroup(comp0, ref), ref)
    useUi.getState().selectFreeze({ index, atSec: span.atSec })
    const targets = collectSnapTargets(refKeys([ref]))
    let dragged = false
    trackHorizontalDrag(
      e,
      (dx) => {
        // A press that barely moves is a pick, not a re-time (no snap, no undo step).
        if (!dragged && Math.abs(dx) <= CLICK_SLOP) return
        dragged = true
        const edge = snap(span.endSec + dx / pxPerSec, targets, SNAP_PX / pxPerSec)
        useProject.getState().liveUpdate((p) => ({
          ...p,
          layers: p.layers.map((l) => (l.id === layer.id ? setFreezeHold(layer, c, index, edge - span.startSec) : l))
        }))
      },
      () => {
        if (dragged) useProject.getState().commitLive(before)
      }
    )
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
    const { startSec, endSec } = seg
    trackHorizontalDrag(
      e,
      (dx) => {
        const d = dx / pxPerSec
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
      },
      commitFrom(before)
    )
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
    trackHorizontalDrag(
      e,
      (dx) => {
        const d = dx / pxPerSec
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
      },
      commitFrom(before)
    )
  }

  return { startTileDrag, startLayerDrag, startCaptionDrag, startAudioDrag, startFreezeDrag }
}
