/** Preview ▸ layers: `StackLayer` (how ONE layer renders, at any depth) and `CompFill` (a whole composition composited into a rect). Graphics layers render in `graphics.tsx`. */

import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type {
  CompoundContent,
  Composition,
  ImageContent,
  Layer,
  LayoutContent,
  TextContent,
  VideoContent
} from '@shared/project'
import { videoSpeed } from '@shared/project'
import { hasSpeedRamp, videoSpeedAtSource } from '@shared/speed'
import { compositionDuration, MAX_COMP_DEPTH } from '@shared/compositions'
import { cellSpan, FULL_CELL, layoutCellRect } from '@shared/layouts'
import { type MediaAsset } from '@shared/media'
import { textWrapWidth } from '@shared/textStyle'
import {
  effectiveImageAspect,
  isFrozenAt,
  layersAtTime,
  layerTransformAt,
  videoSourceTime,
  type FrameRect
} from '@shared/layers'
import { assertNever } from '@shared/layerKinds'
import { clampAnimWindows, effectiveTextAnimation, textAnimStateAt } from '@shared/textAnim'
import { motionPosAt, textMotion } from '@shared/motion'
import { rotateVec } from '@shared/rotation'
import { activeSparkle, sparklesFor } from '@shared/sparkle'
import { LOGICAL } from '@/lib/coords'
import { imageUrl, thumbUrl, videoProxyUrl } from '@/ipc/client'
import { useMediaGain } from '@/lib/mediaGain'
import { useProject } from '@/state/projectStore'
import { pct, FrameCtx, frameCanvasStyle } from './frame'
import {
  mediaBox,
  withKeyframedTransform,
  layerRotation,
  flipTransform,
  videoFillStyle,
  mediaAspect,
  TintFilter
} from './geometry'
import { StyledText, TextBlock, InlineTextEditor, Sparkles } from './text'
import { CompAudioTrack } from './audio'
import { StackGraphics } from './graphics'
import { StackWorkout } from './workout'
import { PoseOverlay } from './pose'

/** One composited video layer: a <video> that follows the master clock. */
function VideoLayerView({
  layer,
  content,
  asset,
  time,
  playing,
  selected,
  boxStyle,
  onMoveDown,
  muted = false,
  editable = false
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset
  time: number
  playing: boolean
  selected: boolean
  boxStyle: CSSProperties
  onMoveDown: (e: ReactPointerEvent) => void
  /** Silenced by an ancestor (a muted layout cell the comp fills). */
  muted?: boolean
  /** A layer of the comp being edited (its pose people can be picked). */
  editable?: boolean
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const target = videoSourceTime(content, layer, time)
  // During a freeze hold, treat the element as paused on the held frame so it
  // doesn't drift past it (and trigger reseek jitter).
  const frozen = isFrozenAt(content, layer, time)
  const fill = useMemo(() => videoFillStyle(content, asset), [content, asset])

  // Clip speed: the element plays at the same rate the shared time mapping
  // advances, so the drift-resync stays quiet. Constant speed sets the rate
  // once; a RAMP re-derives the instantaneous rate from the profile at the
  // current source position each tick (piecewise-linear, so it only actually
  // changes while crossing a ramped segment). Chromium time-stretches
  // (preservesPitch) like the export's atempo — but a ramped clip is muted on
  // both sides (no variable-tempo export path).
  const ramped = hasSpeedRamp(content)
  const speed = ramped ? videoSpeedAtSource(content, target) : videoSpeed(content)
  useEffect(() => {
    const v = ref.current
    if (v && v.playbackRate !== speed) v.playbackRate = speed
  }, [speed])

  // A ramped clip is muted on both sides (no variable-tempo export path), and a
  // muted layout cell silences whatever fills it.
  const silenced = content.mute || ramped || muted
  // The layer's own gain was previously not applied to the preview at all,
  // while the export mixed it in via `volume=`. @see lib/mediaGain.ts
  useMediaGain(ref, content.gainDb, silenced)

  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing && !frozen) {
      if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target
      if (v.paused) void v.play().catch(() => {})
    } else {
      if (!v.paused) v.pause()
      if (v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.05) v.currentTime = target
    }
  }, [playing, frozen, target])

  return (
    <div
      style={boxStyle}
      onPointerDown={onMoveDown}
      data-resizebox={selected ? '' : undefined}
      className={`overflow-hidden ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : 'cursor-pointer'}`}
    >
      {/* Flips mirror the CROPPED picture, so they act on this box-filling
          wrapper — flipping the (larger, offset) <video> itself would mirror
          the whole source and show the wrong region. */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', transform: flipTransform(content) }}>
        <TintFilter tint={content.tint} />
        <video
          ref={ref}
          // Before `src` — see the AudioFollower note; a layer clip can be
          // boosted too, and a tainted element cannot be un-tainted.
          crossOrigin="anonymous"
          src={videoProxyUrl(asset)}
          muted={silenced}
          playsInline
          style={fill}
          onLoadedMetadata={() => {
            const v = ref.current
            if (v) {
              v.currentTime = target
              v.muted = silenced
            }
          }}
        />
      </div>
      {/* Outside the flip wrapper: the overlay mirrors its points itself, so
          angle labels never read backwards. */}
      <PoseOverlay layer={layer} content={content} asset={asset} time={time} editable={editable} />
    </div>
  )
}
/** One cell of a layout: a cover-fit <video> following the master clock at 1×
 *  from the layout's start (same drift-resync pattern as `VideoLayerView`). */
function LayoutCellVideo({
  asset,
  mute,
  target,
  playing,
  style
}: {
  asset: MediaAsset
  mute: boolean
  target: number
  playing: boolean
  style: CSSProperties
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing) {
      if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target
      if (v.paused) void v.play().catch(() => {})
    } else {
      if (!v.paused) v.pause()
      if (v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.05) v.currentTime = target
    }
  }, [playing, target])
  return (
    <div style={{ ...style, overflow: 'hidden' }}>
      <video
        ref={ref}
        src={videoProxyUrl(asset)}
        muted={mute}
        playsInline
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', maxWidth: 'none' }}
        onLoadedMetadata={() => {
          const v = ref.current
          if (v) {
            v.currentTime = target
            v.muted = mute
          }
        }}
      />
    </div>
  )
}
/**
 * A multi-clip layout layer: its cells rendered inside the layer's transformed
 * full-frame box (so the inner cell offsets are plain preset fractions — the
 * wrapper carries the move/zoom). A cell disappears when its span or the layer
 * window ends (lower layers show through), and its cover-fit matches the
 * export's `coverCrop` — both sides resolve geometry via `layoutCellRect`.
 */
function LayoutLayerView({
  layer,
  content,
  assetById,
  time,
  playing,
  selected,
  boxStyle,
  onMoveDown,
  depth = 1,
  muted = false
}: {
  layer: Layer
  content: LayoutContent
  assetById: Map<string, MediaAsset>
  time: number
  playing: boolean
  selected: boolean
  boxStyle: CSSProperties
  onMoveDown: (e: ReactPointerEvent) => void
  /** Comp nesting level of the composition this layout lives in. */
  depth?: number
  /** Silenced by an ancestor comp (a muted cell above this one). */
  muted?: boolean
}): JSX.Element {
  const local = time - layer.startSec
  const window = Math.max(0, layer.endSec - layer.startSec)
  return (
    <div
      style={boxStyle}
      onPointerDown={onMoveDown}
      data-resizebox={selected ? '' : undefined}
      className={`overflow-hidden ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : 'cursor-pointer'}`}
    >
      {content.cells.map((cell, i) => {
        const rel: CSSProperties = {
          position: 'absolute',
          left: pct(cell.rect.x, LOGICAL.width),
          top: pct(cell.rect.y, LOGICAL.height),
          width: pct(cell.rect.w, LOGICAL.width),
          height: pct(cell.rect.h, LOGICAL.height)
        }
        // A cell carrying a nested composition IS that comp: it renders the
        // whole sub-timeline (cover-cropped into the panel) instead of a single
        // clip, and overrides `mediaId`. Its span is the comp's own duration.
        if (cell.comp) {
          const compSpan = Math.min(
            compositionDuration(cell.comp, (id) => assetById.get(id)?.probe.durationSec ?? 0),
            window
          )
          if (local < 0 || local >= compSpan) {
            return selected ? <div key={i} style={rel} className="border border-dashed border-white/25" /> : null
          }
          return (
            <div key={i} style={{ ...rel, overflow: 'hidden', containerType: 'size' }}>
              <CompFill
                comp={cell.comp}
                time={local}
                playing={playing}
                assetById={assetById}
                depth={depth + 1}
                muted={muted || cell.mute}
              />
            </div>
          )
        }
        const asset = cell.mediaId ? assetById.get(cell.mediaId) : undefined
        const effSpan = Math.min(cellSpan(cell), window)
        if (asset?.proxyReady && asset.probe.video && local >= 0 && local < effSpan) {
          return (
            <LayoutCellVideo
              key={i}
              asset={asset}
              mute={cell.mute || muted}
              target={cell.inSec + local}
              playing={playing}
              style={rel}
            />
          )
        }
        if (asset && local >= 0 && local < effSpan) {
          // Proxy still building: hold the thumb so the cell doesn't flash empty.
          return (
            <div key={i} style={{ ...rel, overflow: 'hidden' }}>
              <img src={thumbUrl(asset)} alt="" className="h-full w-full object-cover opacity-40" />
            </div>
          )
        }
        // Empty / out-of-span cell: outline it while selected so the slots show.
        return selected ? <div key={i} style={rel} className="border border-dashed border-white/25" /> : null
      })}
    </div>
  )
}
/**
 * ONE layer of a composition stack. The single implementation of how a layer
 * looks: the interactive root stage renders it with a real selection and drag
 * handler, and a nested composition renders the SAME component read-only
 * (`selected={false}`, no-op pointer handler) through `CompFill` — so nesting
 * can never drift from the root rendering.
 *
 * `time` is LOCAL to the composition this layer lives in; `depth` is the comp
 * nesting level, carried down so recursion can be capped.
 */
export function StackLayer(props: StackLayerProps): JSX.Element | null {
  const layer = withKeyframedTransform(props.rawLayer, props.time)
  const view = { ...props, depth: props.depth ?? 1, muted: props.muted ?? false, layer }
  const c = layer.content
  switch (c.kind) {
    case 'video':
      return <StackVideo {...view} content={c} />
    case 'image':
      return <StackImage {...view} content={c} />
    case 'layout':
      return <StackLayout {...view} content={c} />
    case 'compound':
      return <StackCompound {...view} content={c} />
    case 'text':
      return <StackText {...view} content={c} />
    case 'workout':
      return (
        <StackWorkout
          layer={layer}
          content={c}
          z={props.z}
          time={props.time}
          selected={props.selected}
          editable={!!props.editable}
        />
      )
    case 'graphics':
      return (
        <StackGraphics
          layer={layer}
          rawLayer={props.rawLayer}
          content={c}
          z={props.z}
          time={props.time}
          selected={props.selected}
          editable={!!props.editable}
        />
      )
    default:
      return assertNever(c, 'layer kind')
  }
}

interface StackLayerProps {
  rawLayer: Layer
  z: number
  time: number
  playing: boolean
  assetById: Map<string, MediaAsset>
  selected: boolean
  onMoveDown: (e: ReactPointerEvent) => void
  depth?: number
  /** Silenced by an ancestor comp (a muted cell it fills). */
  muted?: boolean
  /** A layer of the comp being edited: its text can be edited in place. */
  editable?: boolean
}

/** What each per-kind view gets: the stack props, the layer with its keyframed
 *  transform applied at `time`, and its content narrowed to the kind. */
type KindViewProps<C> = StackLayerProps & { depth: number; muted: boolean; layer: Layer; content: C }

/** Keyframed opacity (video/image): same shared interpolation the export bakes
 *  into its sendcmd `aa` ramp — applied on the layer box. */
const keyframedOpacity = (rawLayer: Layer, time: number): CSSProperties => {
  const op = layerTransformAt(rawLayer, time).opacity
  return op < 1 ? { opacity: op } : {}
}

/** The layer-transformed FULL-FRAME rect as a box: what a layout's cells and a
 *  compound clip's composition fill — the same numbers `layoutCellRect` gives
 *  the export. */
function frameRectBox(layer: Layer, frame: FrameRect, z: number): CSSProperties {
  const r = layoutCellRect(layer, FULL_CELL, frame)
  return {
    position: 'absolute',
    left: pct(r.x, LOGICAL.width),
    top: pct(r.y, LOGICAL.height),
    width: pct(r.w, LOGICAL.width),
    height: pct(r.h, LOGICAL.height),
    zIndex: z
  }
}

function StackVideo({
  layer,
  rawLayer,
  content,
  assetById,
  z,
  time,
  playing,
  selected,
  onMoveDown,
  muted,
  editable
}: KindViewProps<VideoContent>): JSX.Element {
  const asset = assetById.get(content.mediaId)
  const box = {
    ...mediaBox(layer, mediaAspect(asset, content)),
    zIndex: z,
    ...keyframedOpacity(rawLayer, time)
  }
  if (!asset?.proxyReady || !asset.probe.video) {
    return (
      <div
        style={box}
        onPointerDown={onMoveDown}
        data-resizebox={selected ? '' : undefined}
        className={`flex items-center justify-center overflow-hidden bg-zinc-900/70 text-[10px] text-zinc-500 ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : ''}`}
      >
        {asset ? <img src={thumbUrl(asset)} alt="" className="h-full w-full object-cover opacity-40" /> : 'missing'}
      </div>
    )
  }
  return (
    <VideoLayerView
      layer={layer}
      content={content}
      asset={asset}
      time={time}
      playing={playing}
      selected={selected}
      boxStyle={box}
      onMoveDown={onMoveDown}
      muted={muted}
      editable={!!editable}
    />
  )
}

function StackImage({
  layer,
  rawLayer,
  content,
  assetById,
  z,
  time,
  selected,
  onMoveDown
}: KindViewProps<ImageContent>): JSX.Element {
  const asset = assetById.get(content.mediaId)
  // Effective aspect: base → reshaped by crop → swapped by 90°/270° rotation.
  const base = mediaAspect(asset, {})
  const cr = content.crop
  const aspect = effectiveImageAspect(base, cr, content.rotateQuarters)
  const q = (((content.rotateQuarters ?? 0) % 4) + 4) % 4
  const odd = q === 1 || q === 3
  const box = {
    ...mediaBox(layer, aspect),
    zIndex: z,
    containerType: 'size' as const,
    ...keyframedOpacity(rawLayer, time)
  }
  // Inner wrapper holds the un-rotated crop; rotating it 90° must fill the
  // box, so swap its width/height (cqw/cqh resolve to the box via its
  // container context) for odd quarter-turns.
  const flip = `scaleX(${content.flipH ? -1 : 1}) scaleY(${content.flipV ? -1 : 1})`
  const imgStyle: CSSProperties = cr
    ? {
        position: 'absolute',
        width: `${100 / cr.w}%`,
        height: `${100 / cr.h}%`,
        left: `${-(cr.x / cr.w) * 100}%`,
        top: `${-(cr.y / cr.h) * 100}%`,
        objectFit: 'fill',
        maxWidth: 'none',
        opacity: content.opacity
      }
    : { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', opacity: content.opacity }
  return (
    <div
      style={box}
      onPointerDown={onMoveDown}
      data-resizebox={selected ? '' : undefined}
      className={`overflow-hidden ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : 'cursor-pointer'}`}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: odd ? '100cqh' : '100cqw',
          height: odd ? '100cqw' : '100cqh',
          transform: `translate(-50%, -50%) rotate(${q * 90}deg) ${flip}`,
          overflow: 'hidden'
        }}
      >
        <img src={imageUrl(asset ?? { id: content.mediaId })} alt="" draggable={false} style={imgStyle} />
      </div>
    </div>
  )
}

/** The wrapper is the layer's transformed FULL-FRAME rect; cells sit inside at
 *  their plain preset fractions (the wrapper carries the move/zoom). */
function StackLayout({
  layer,
  content,
  assetById,
  z,
  time,
  playing,
  selected,
  onMoveDown,
  depth,
  muted
}: KindViewProps<LayoutContent>): JSX.Element {
  const frame = useContext(FrameCtx)
  return (
    <LayoutLayerView
      layer={layer}
      content={content}
      assetById={assetById}
      time={time}
      playing={playing}
      selected={selected}
      boxStyle={frameRectBox(layer, frame, z)}
      onMoveDown={onMoveDown}
      depth={depth}
      muted={muted}
    />
  )
}

/** Like a layout, the box is the layer-transformed FULL-FRAME rect; the nested
 *  comp fills it on its own local clock (comp t=0 at the layer start).
 *  Compounds ignore transform keyframes (`LAYER_KINDS`). */
function StackCompound({
  layer,
  content,
  assetById,
  z,
  time,
  playing,
  selected,
  onMoveDown,
  depth,
  muted
}: KindViewProps<CompoundContent>): JSX.Element {
  const frame = useContext(FrameCtx)
  return (
    <div
      style={{ ...frameRectBox(layer, frame, z), containerType: 'size' as const }}
      onPointerDown={onMoveDown}
      data-resizebox={selected ? '' : undefined}
      className={`overflow-hidden ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : 'cursor-pointer'}`}
    >
      <CompFill
        comp={content.comp}
        time={time - layer.startSec}
        playing={playing}
        assetById={assetById}
        depth={depth + 1}
        muted={muted}
      />
    </div>
  )
}

/**
 * Text layer — the same `TextBlock` a caption renders through. Explicit
 * `widthPx` (from a side-resize) fixes the wrap width; otherwise it hugs
 * content up to the shared frame-relative wrap width. Animation state comes
 * from the shared per-frame helper (playhead-driven, so scrub/pause stay exact
 * — never CSS animations).
 */
function StackText({
  layer,
  content,
  z,
  time,
  selected,
  onMoveDown,
  editable
}: KindViewProps<TextContent>): JSX.Element {
  const frame = useContext(FrameCtx)
  const [editing, setEditing] = useState(false)
  const textAnim = effectiveTextAnimation(content)
  const anim = textAnimStateAt(textAnim, layer.startSec, layer.endSec, content.text, time)
  // Sparkles: same shared generator the export burns from, fed the LOGICAL
  // font size here and the output-scaled one there. Every offset it returns
  // is a multiple of that size, so the two layouts agree at any preset.
  const sparkleEffect = activeSparkle(content.effects)
  const layerDur = Math.max(0.01, layer.endSec - layer.startSec)
  const sparkles = sparkleEffect
    ? sparklesFor({
        effect: sparkleEffect,
        text: content.text,
        fontSizePx: content.fontSizePx,
        durSec: layerDur,
        typewriterSec: textAnim?.in === 'typewriter' ? clampAnimWindows(textAnim, layerDur).inSec : 0
      })
    : []
  // A slide travels along the text's OWN (rotated) axis — the export's
  // \move runs about a fixed \org, which turns it the same way.
  const rot = layerRotation(layer)
  const slide = rotateVec(0, anim.dy, rot)
  // Straight-line motion: text follows its keyframes for POSITION only,
  // through the same `textMotion` the export burns from.
  const mo = textMotion(layer.keyframes)
  const pos = mo ? motionPosAt(mo, time - layer.startSec) : { x: layer.x, y: layer.y }
  return (
    <TextBlock
      s={content}
      x={pos.x + slide.x}
      y={pos.y + slide.y}
      wrap={{ widthPx: content.widthPx, wrapWidthPx: textWrapWidth(frame.w) }}
      rotationDeg={rot}
      scale={layer.scale * anim.scale}
      opacity={anim.opacity}
      zIndex={z}
      onPointerDown={onMoveDown}
      onDoubleClick={editable ? () => setEditing(true) : undefined}
      handleTarget={selected}
      className={`cursor-move ${selected ? 'outline-dashed outline-2 outline-sky-400' : ''}`}
    >
      {editing ? (
        <InlineTextEditor
          initial={content.text}
          color={content.gradient ? '#ffffff' : content.color}
          onChange={(text) => useProject.getState().updateLayerContent(layer.id, { text })}
          onDone={() => setEditing(false)}
        />
      ) : (
        <StyledText s={content} text={content.text} reveal={anim.revealChars} litWords={anim.litWords} />
      )}
      {!editing && sparkleEffect && (
        <Sparkles sparkles={sparkles} color={sparkleEffect.color} tLocal={time - layer.startSec} />
      )}
    </TextBlock>
  )
}

/** Read-only stacks need a handler; hoisted so the identity stays stable. */
const noopPointer = (): void => {}
/**
 * A nested composition rendered inside a rect. The comp is seen through the
 * project's output frame, like the root — a frame-shaped box sized to COVER the
 * container (center-crop — the comp twin of a layout cell's `object-fit: cover`,
 * matching what the export's frame-sized pre-render + coverCrop produce; a
 * compound clip's box IS frame-shaped, so it fits exactly), holding the comp's
 * canonical canvas. Its stack renders recursively through `StackLayer` on the
 * LOCAL clock (comp time 0 = the parent window start).
 *
 * Read-only: enter the comp to edit it. A comp shown here plays its VIDEO
 * only — nested audio and captions arrive with the export's pre-render
 * (Stage 5 closes the preview gap). Renders nothing outside the comp span or
 * past `MAX_COMP_DEPTH`.
 */
export function CompFill({
  comp,
  time,
  playing,
  assetById,
  depth,
  muted = false
}: {
  comp: Composition
  time: number
  playing: boolean
  assetById: Map<string, MediaAsset>
  depth: number
  /** Silenced by the parent (a muted layout cell). Mutes the comp's whole
   *  mix — its audio track AND the clips inside it — matching the export,
   *  which skips a muted cell's intermediate audio entirely. */
  muted?: boolean
}): JSX.Element | null {
  const frame = useContext(FrameCtx)
  if (depth > MAX_COMP_DEPTH) return null
  const srcDur = (id: string): number => assetById.get(id)?.probe.durationSec ?? 0
  if (time < 0 || time >= compositionDuration(comp, srcDur)) return null
  const active = layersAtTime(comp.layers, time).filter((l) => !l.hidden)
  return (
    <div
      data-testid="comp-fill"
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: `max(100cqw, calc(100cqh * ${frame.w / frame.h}))`,
        aspectRatio: `${frame.w} / ${frame.h}`,
        overflow: 'hidden'
      }}
    >
      <div style={frameCanvasStyle(frame)}>
        {/* The comp's own audio track — without this a comp whose clips are
            muted and extracted to its audio lane would play silent. */}
        {!muted && <CompAudioTrack clips={comp.audioClips} assetById={assetById} time={time} playing={playing} />}
        {active.map((l, i) => (
          <StackLayer
            key={l.id}
            rawLayer={l}
            z={10 + i}
            time={time}
            playing={playing}
            assetById={assetById}
            selected={false}
            onMoveDown={noopPointer}
            depth={depth}
            muted={muted}
          />
        ))}
      </div>
    </div>
  )
}
