/**
 * The preview stage: the frame, the composited layer stack at the playhead, the
 * captions, the playback clock and the canvas interactions (move, resize,
 * rotate, motion-path drags). How a layer or text block renders lives in
 * `components/preview/`.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { CaptionSegment, Layer } from '@shared/project'
import { audioClipEnd, effectiveCaptionStyle } from '@shared/project'
import { assetAspect } from '@shared/media'
import { textWrapWidth } from '@shared/textStyle'
import { layersAtTime, makeVideoLayer, visualDuration, type ResizeHandle } from '@shared/layers'
import { kindInfo } from '@shared/layerKinds'
import { isSimpleMotion, simpleMotion } from '@shared/motion'
import { pointerAngleDeg, resizeRotatedBox, rotateDragDeg } from '@shared/rotation'
import { LOGICAL } from '@/lib/coords'
import { startDragWithUndo } from '@/lib/pointerDrag'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { activeComp, getActiveComp, projectFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { pct, EMPTY_LAYERS, EMPTY_AUDIO, FrameCtx, frameCanvasStyle } from './preview/frame'
import { withKeyframedTransform, layerRotation, MeasuredBox, measureSelectedBox } from './preview/geometry'
import { StyledText, TextBlock } from './preview/text'
import { HANDLE_SETS, ResizeHandles, MotionPath } from './preview/handles'
import { dragKeyframe, dragMode, movedLayer, movedMotionEnd, resizedLayer, withCaptionStyle } from '@/lib/canvasDrag'
import { CompAudioTrack } from './preview/audio'
import { StackLayer } from './preview/layers'

/**
 * The playback surface, shaped like the project's output format. Composites the
 * unified layer stack (multiple videos/images/text at once), driven by a single
 * wall-clock master so several videos can play together. Layers move/zoom in
 * the canonical 1080x1920 logical space; the stage shows the format's frame — a
 * window on that space — and crops the rest, exactly as the export does.
 * Uncovered areas are black. Fills its parent (the dock panel sizes it to the
 * frame's aspect).
 */
export function PreviewStage(): JSX.Element {
  const format = useProject(projectFormat)
  const frame = format.frame
  const project = useProject(activeComp)
  const layers = project?.layers ?? EMPTY_LAYERS
  const audioClips = project?.audioClips ?? EMPTY_AUDIO
  const captions = project?.captions
  const selectedLayerId = useUi((s) => s.selectedLayerId)
  const selectedCaptionId = useUi((s) => s.selectedCaptionId)
  const selectedLibId = useEditor((s) => s.selectedId)
  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)

  // With an empty stack, fall back to previewing the selected library video.
  const selectedAsset = selectedLibId ? assetById.get(selectedLibId) : undefined
  const previewLayers: Layer[] = useMemo(() => {
    if (layers.length) return layers
    if (selectedAsset?.probe.video && selectedAsset.proxyReady) {
      return [
        makeVideoLayer('__preview__', selectedAsset.id, 0, selectedAsset.probe.durationSec, {
          frame,
          aspect: assetAspect(selectedAsset)
        })
      ]
    }
    return EMPTY_LAYERS
  }, [layers, selectedAsset, frame])

  const audioEnd = useMemo(
    () =>
      audioClips.reduce(
        (max, a) => Math.max(max, audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)),
        0
      ),
    [audioClips, assetById]
  )
  const duration = Math.max(visualDuration(previewLayers), audioEnd)
  const durationRef = useRef(duration)
  durationRef.current = duration

  const stageRef = useRef<HTMLDivElement>(null)

  // Master clock: a wall clock advances `time` while playing (so any number of
  // video layers can play at once); each video follows it independently.
  useEffect(() => {
    if (!playing) return undefined
    if (usePlayback.getState().time >= durationRef.current - 0.05) usePlayback.getState().setTime(0)
    let raf = 0
    let last = performance.now()
    const tick = (): void => {
      if (!usePlayback.getState().playing) return
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      const nt = usePlayback.getState().time + dt
      if (nt >= durationRef.current - 0.001) {
        usePlayback.getState().setPlaying(false)
        usePlayback.getState().setTime(Math.max(0, durationRef.current))
        return
      }
      usePlayback.getState().setTime(nt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  /** The canvas's px → canonical logical px factor (it is 1080 logical px wide). */
  const logicalPerPx = (stage: HTMLElement): number => LOGICAL.width / stage.getBoundingClientRect().width

  /** Rewrite layer `id` of the active composition, live (one undo step on release). */
  const liveLayer = (id: string, fn: (l: Layer) => Layer): void =>
    useProject.getState().liveUpdate((p) => ({ ...p, layers: p.layers.map((l) => (l.id === id ? fn(l) : l)) }))

  /** The stored form of a layer the drag started on (its keyframes, unbaked). */
  const rawLayer = (layer: Layer): Layer => getActiveComp()?.layers.find((l) => l.id === layer.id) ?? layer

  // Drag a layer to move it (logical coords), one undo step on release. A layer
  // on a PATH moves as a whole; a keyframed one gets a keyframe at the playhead
  // (`canvasDrag.ts`). `layer.x/y` are already the effective values at `time`.
  const startLayerMove = (e: ReactPointerEvent, layer: Layer): void => {
    e.stopPropagation()
    e.preventDefault()
    // Picks the whole link group, like the timeline — a group is never partly
    // selected, or the next timeline drag would move one member on its own.
    useUi.getState().selectTile(useProject.getState().project, { kind: 'layer', id: layer.id })
    const stage = stageRef.current
    if (!stage) return
    const scale = logicalPerPx(stage)
    const startX = e.clientX
    const startY = e.clientY
    const raw = rawLayer(layer)
    const mode = dragMode(raw, layer)
    const kf = dragKeyframe(layer, usePlayback.getState().time)
    startDragWithUndo((ev) => {
      const nx = layer.x + (ev.clientX - startX) * scale
      const ny = layer.y + (ev.clientY - startY) * scale
      liveLayer(layer.id, (l) => movedLayer(l, layer, raw, mode, nx, ny, kf))
    })
  }

  // Drag an edge/corner handle to resize the selected layer. Corners scale
  // uniformly (aspect preserved); edges distort media (per-axis stretch) or, for
  // text, change the wrap width. The opposite edge/corner stays put, so the drag
  // also shifts x/y. Box geometry comes from the DOM (text height is intrinsic).
  const startLayerResize = (e: ReactPointerEvent, layer: Layer, handle: ResizeHandle): void => {
    e.stopPropagation()
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const startBox = measureSelectedBox(stage)
    if (!startBox) return
    const s = logicalPerPx(stage)
    const startX = e.clientX
    const startY = e.clientY
    const raw = rawLayer(layer)
    const mode = dragMode(raw, layer)
    const kf = dragKeyframe(layer, usePlayback.getState().time)
    startDragWithUndo((ev) => {
      const dx = (ev.clientX - startX) * s
      const dy = (ev.clientY - startY) * s
      // Turned into the box's own axes, so a rotated edge stretches along its side.
      const nb = resizeRotatedBox(startBox, handle, dx, dy, handle.length === 2, startBox.rotationDeg)
      // The centre moves by the box's shift — BOTH axes, since on a rotated box
      // even a side handle moves the centre diagonally. Applied as a delta, so a
      // measured centre that sits off the layer's own (a text slide mid-way)
      // can't leak into the position.
      const x = layer.x + (nb.cx - startBox.cx)
      const y = layer.y + (nb.cy - startBox.cy)
      liveLayer(layer.id, (l) => resizedLayer(l, layer, raw, mode, handle, startBox, nb, x, y, kf))
    })
  }

  // Drag a caption to move it. In lane-wide ("Captions" label) mode this moves the
  // global style (all non-overridden captions); otherwise it moves just this
  // caption, creating an override that exempts it from the lane style.
  const startCaptionMove = (e: ReactPointerEvent, seg: CaptionSegment): void => {
    e.stopPropagation()
    e.preventDefault()
    const global = useUi.getState().captionsGlobalSelected
    if (!global) useUi.getState().selectCaption(seg.id)
    const stage = stageRef.current
    if (!stage) return
    const scale = logicalPerPx(stage)
    const startX = e.clientX
    const startY = e.clientY
    startDragWithUndo((ev, before) => {
      const base = effectiveCaptionStyle(before.captions, seg)
      const patch = { x: base.x + (ev.clientX - startX) * scale, y: base.y + (ev.clientY - startY) * scale }
      useProject.getState().liveUpdate((p) => ({ ...p, captions: withCaptionStyle(p.captions, seg.id, global, patch) }))
    })
  }

  // Rotate-handle drag — THE one rotate interaction; `apply` is the only part
  // that differs between a layer and a caption. Relative to where the drag
  // began (no jump on grab), snapping near right angles; Shift steps by 15°.
  const startRotate = (e: ReactPointerEvent, startDeg: number, apply: (deg: number) => void): void => {
    e.stopPropagation()
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const box = measureSelectedBox(stage)
    if (!box) return
    const sr = stage.getBoundingClientRect()
    const s = LOGICAL.width / sr.width
    const angleAt = (ev: { clientX: number; clientY: number }): number =>
      pointerAngleDeg(box.cx, box.cy, (ev.clientX - sr.left) * s, (ev.clientY - sr.top) * s)
    const startPointer = angleAt(e)
    startDragWithUndo((ev) => apply(rotateDragDeg(startDeg, startPointer, angleAt(ev), ev.shiftKey)))
  }

  const startLayerRotate = (e: ReactPointerEvent, layer: Layer): void =>
    startRotate(e, layerRotation(layer), (deg) => liveLayer(layer.id, (l) => ({ ...l, rotationDeg: deg || undefined })))

  // Drag one end of a simple move (`MotionPath` dot): that keyframe's position
  // follows the pointer; the other end, and both times, stay put.
  const startMotionEndDrag = (e: ReactPointerEvent, layer: Layer, end: 0 | 1): void => {
    e.stopPropagation()
    e.preventDefault()
    const stage = stageRef.current
    const kfs = layer.keyframes
    if (!stage || !isSimpleMotion(kfs)) return
    const s = logicalPerPx(stage)
    const startX = e.clientX
    const startY = e.clientY
    startDragWithUndo((ev) => {
      const next = movedMotionEnd(kfs, end, (ev.clientX - startX) * s, (ev.clientY - startY) * s)
      liveLayer(layer.id, (l) => ({ ...l, keyframes: next }))
    })
  }

  // Same rule as a caption drag: lane-wide mode turns the global style,
  // otherwise this caption gets (or updates) its own override.
  const startCaptionRotate = (e: ReactPointerEvent, seg: CaptionSegment): void => {
    const global = useUi.getState().captionsGlobalSelected
    const comp = getActiveComp()
    if (!comp) return
    startRotate(e, effectiveCaptionStyle(comp.captions, seg).rotationDeg, (deg) =>
      useProject.getState().liveUpdate((p) => ({
        ...p,
        captions: withCaptionStyle(p.captions, seg.id, global, { rotationDeg: deg })
      }))
    )
  }

  const activeLayers = layersAtTime(previewLayers, time).filter((l) => !l.hidden)
  const selectedLayer = activeLayers.find((l) => l.id === selectedLayerId) ?? null

  // Measure the selected layer's box for the resize handles. Re-runs whenever the
  // layer object changes (incl. each live drag frame) and on stage resize, so the
  // handles track the box. `useLayoutEffect` reads the freshly committed DOM.
  // All captions on screen now (audio clips are captioned independently, so two
  // overlapping clips can show two captions at once — stack them).
  const activeCaptions = captions?.enabled
    ? captions.segments.filter((s) => s.enabled && time >= s.startSec && time < s.endSec)
    : []
  // The caption the rotate handle acts on: the selected one, or — in lane-wide
  // mode — the first on screen that follows the lane style. Only when no layer
  // is selected, so a single element carries the `data-resizebox` tag.
  const captionsGlobal = useUi((s) => s.captionsGlobalSelected)
  const handleCaption = selectedLayer
    ? null
    : (activeCaptions.find((c) => (captionsGlobal ? !c.style : c.id === selectedCaptionId)) ?? null)
  const handleCaptionStyle = handleCaption && captions ? effectiveCaptionStyle(captions, handleCaption) : null

  const [handleBox, setHandleBox] = useState<MeasuredBox | null>(null)
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || (!selectedLayer && !handleCaption)) {
      setHandleBox(null)
      return undefined
    }
    const update = (): void => setHandleBox(measureSelectedBox(stage))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
    // A keyframed layer's box moves with the playhead — re-measure per tick.
    // A format change resizes the canvas (and reshapes layouts/text wraps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayer, selectedLayer?.keyframes?.length ? time : 0, frame, handleCaption?.id, handleCaptionStyle])

  const hasContent = previewLayers.length > 0

  // A press on empty stage (the frame outside the canvas, or the canvas itself)
  // clears the layer selection.
  const deselectOnBackground = (e: ReactPointerEvent): void => {
    if (e.target === e.currentTarget) useUi.getState().selectLayer(null)
  }

  return (
    <FrameCtx.Provider value={frame}>
      <div className="relative isolate h-full w-full" data-testid="preview-stage" data-format={format.id}>
        {/* The FRAME: the project's output shape. Clips everything to it. */}
        <div
          data-testid="preview-frame"
          onPointerDown={deselectOnBackground}
          className="absolute inset-0 isolate overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
        >
          {/* The canonical canvas the whole stack lives in (pointer math and
              box measuring read THIS element — it is 1080 logical px wide). */}
          <div
            ref={stageRef}
            data-testid="preview-canvas"
            style={frameCanvasStyle(frame)}
            onPointerDown={deselectOnBackground}
          >
            {/* Audio track of the composition being edited. Nested comps render
                their own through CompFill, so every level reaches the mix. */}
            <CompAudioTrack clips={audioClips} assetById={assetById} time={time} playing={playing} />

            {/* The composited layer stack, back (index 0) → front. */}
            {activeLayers.map((rawLayer, i) => (
              <StackLayer
                key={rawLayer.id}
                rawLayer={rawLayer}
                z={10 + i}
                time={time}
                playing={playing}
                assetById={assetById}
                selected={rawLayer.id === selectedLayerId}
                onMoveDown={(e) => startLayerMove(e, withKeyframedTransform(rawLayer, time))}
                editable
              />
            ))}

            {/* Active captions: each rendered at its own effective style (lane-wide or
                per-caption override) through the SAME TextBlock as a text layer,
                centred on its position, draggable to reposition. */}
            {captions &&
              activeCaptions.map((seg) => {
                const st = effectiveCaptionStyle(captions, seg)
                const selected = seg.id === selectedCaptionId
                return (
                  <TextBlock
                    key={seg.id}
                    s={st}
                    x={st.x}
                    y={st.y}
                    wrap={{ wrapWidthPx: textWrapWidth(frame.w) }}
                    rotationDeg={st.rotationDeg}
                    zIndex={300}
                    handleTarget={seg.id === handleCaption?.id}
                    onPointerDown={(e) => startCaptionMove(e, seg)}
                    className={`cursor-move ${selected ? 'outline-dashed outline-2 outline-emerald-400' : ''}`}
                  >
                    <StyledText s={st} text={seg.text} />
                  </TextBlock>
                )
              })}
          </div>

          {!hasContent && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
              Add a clip to the timeline to begin
            </div>
          )}

          {/* Hook zone (first 3 seconds) */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[400] flex h-[6%] items-center justify-center border-b border-amber-400/30 bg-amber-400/10 text-[10px] uppercase tracking-wide text-amber-300/80">
            Hook zone · first 3s
          </div>
          {/* The format's platform UI safe zones (Instagram's caption bar and
              action rail on the Reel/Story presets), in frame px. Borders only
              on the sides that face into the frame. */}
          {format.safeZones?.map((z, i) => (
            <div
              key={i}
              data-testid="safe-zone"
              className="pointer-events-none absolute z-[400] border-rose-400/40 bg-rose-500/10"
              style={{
                left: pct(z.x, frame.w),
                top: pct(z.y, frame.h),
                width: pct(z.w, frame.w),
                height: pct(z.h, frame.h),
                borderLeftWidth: z.x > 0 ? 1 : 0,
                borderTopWidth: z.y > 0 ? 1 : 0,
                borderRightWidth: z.x + z.w < frame.w ? 1 : 0,
                borderBottomWidth: z.y + z.h < frame.h ? 1 : 0
              }}
            />
          ))}
          <div className="pointer-events-none absolute left-2 top-2 z-[400] text-[10px] uppercase tracking-wide text-zinc-500">
            {format.ratioLabel} · {format.width} × {format.height}
          </div>
        </div>

        {/* Edge/corner resize handles on the selected layer (corners scale
            uniformly, edges stretch media / re-wrap text) — OUTSIDE the frame's
            clip so a handle on the frame edge stays whole and grabbable. */}
        {selectedLayer && kindInfo(selectedLayer).motion && isSimpleMotion(selectedLayer.keyframes) && (
          <MotionPath
            motion={simpleMotion(selectedLayer.keyframes)}
            frame={frame}
            onStart={(e, end) => startMotionEndDrag(e, selectedLayer, end)}
          />
        )}
        {selectedLayer && handleBox && (
          <ResizeHandles
            box={handleBox}
            frame={frame}
            handles={HANDLE_SETS[kindInfo(selectedLayer).handles]}
            onStart={(e, handle) => startLayerResize(e, withKeyframedTransform(selectedLayer, time), handle)}
            onRotateStart={kindInfo(selectedLayer).rotatable ? (e) => startLayerRotate(e, selectedLayer) : undefined}
          />
        )}
        {/* Captions are text: they get the same rotate handle (no resize —
            their size is the style's font size). */}
        {handleCaption && handleBox && (
          <ResizeHandles
            box={handleBox}
            frame={frame}
            handles={[]}
            onRotateStart={(e) => startCaptionRotate(e, handleCaption)}
          />
        )}
      </div>
    </FrameCtx.Provider>
  )
}
