import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type {
  AudioClip,
  CaptionSegment,
  Composition,
  Layer,
  LayoutContent,
  TextStyleBase,
  VideoContent
} from '@shared/project'
import {
  audioClipAudible,
  audioClipEnd,
  effectiveCaptionStyle,
  effectiveOut,
  videoSpeed
} from '@shared/project'
import { hasSpeedRamp, videoSpeedAtSource } from '@shared/speed'
import { compositionDuration, MAX_COMP_DEPTH } from '@shared/compositions'
import { cellSpan, FULL_CELL, layoutCellRect } from '@shared/layouts'
import { assetAspect, type MediaAsset } from '@shared/media'
import { textBoxCss, textFillCss, textPillCss, textWrapWidth, type TextDeco } from '@shared/textStyle'
import {
  effectiveImageAspect,
  FULL_FRAME,
  isFrozenAt,
  layersAtTime,
  layerTransformAt,
  makeVideoLayer,
  stretchedBox,
  upsertKeyframe,
  videoSourceTime,
  visualDuration,
  type FrameRect,
  type ResizeBox,
  type ResizeHandle
} from '@shared/layers'
import { clampAnimWindows, effectiveTextAnimation, KARAOKE_DIM_OPACITY, textAnimStateAt } from '@shared/textAnim'
import { isSimpleMotion, motionPosAt, shiftKeyframes, simpleMotion, textMotion } from '@shared/motion'
import {
  handleOffset,
  normalizeDeg,
  pointerAngleDeg,
  resizeRotatedBox,
  rotateDragDeg,
  rotateVec
} from '@shared/rotation'
import { activeSparkle, sparkleStateAt, sparklesFor, type Sparkle } from '@shared/sparkle'
import { LOGICAL } from '@/lib/coords'
import { startDragWithUndo } from '@/lib/pointerDrag'
import { audioUrl, imageUrl, thumbUrl, videoProxyUrl } from '@/ipc/client'
import { useMediaGain } from '@/lib/mediaGain'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { activeComp, getActiveComp, projectFormat, useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'

const pct = (value: number, total: number): string => `${(value / total) * 100}%`
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

/** The layer with its keyframed transform baked in for rendering at time `t`
 *  (text layers ignore keyframes — they animate via `TextContent.animation`;
 *  layout layers ignore them too — the export has no keyframe path for them). */
function withKeyframedTransform(l: Layer, t: number): Layer {
  if (!l.keyframes?.length || l.content.kind === 'text' || l.content.kind === 'layout') return l
  const tr = layerTransformAt(l, t)
  return { ...l, x: tr.x, y: tr.y, scale: tr.scale }
}

const EMPTY_LAYERS: Layer[] = []
const EMPTY_AUDIO: AudioClip[] = []

/** A logical-px length expressed in the container-query unit text is sized in, so
 *  fonts/strokes/shadows scale with the stage like the burned output does. The
 *  container is the canonical canvas (`frameCanvasStyle`), 1080 logical px wide. */
const cqw = (px: number): string => `${(px / LOGICAL.width) * 100}cqw`
/** Vertical counterpart of `cqw`, for positioning by the logical y axis. */
const cqh = (px: number): string => `${(px / LOGICAL.height) * 100}cqh`

/**
 * The project's output frame (a window on the canonical space — `shared/frame.ts`),
 * provided once by the stage so every level of the recursive render — root
 * stack, layouts, nested comps — resolves frame-relative geometry the same way.
 */
const FrameCtx = createContext<FrameRect>(FULL_FRAME)

/**
 * The canonical 1080×1920 canvas, positioned inside a frame-shaped parent so
 * the parent shows exactly `frame`. Layers render inside it in canonical
 * coordinates (percentages of LOGICAL, `cqw`/`cqh` of this box), so nothing
 * about a layer changes with the format — the parent's `overflow: hidden` does
 * the cropping. The CSS twin of the export's `frameToOutput`. Identity in 9:16.
 */
function frameCanvasStyle(frame: FrameRect): CSSProperties {
  return {
    position: 'absolute',
    left: pct(-frame.x, frame.w),
    top: pct(-frame.y, frame.h),
    width: pct(LOGICAL.width, frame.w),
    height: pct(LOGICAL.height, frame.h),
    containerType: 'size'
  }
}

/** Fill + outline + shadow for the glyphs — the shared definition
 *  (`shared/textStyle.ts`) the export rasteriser also draws with. */
const fillStyle = (s: TextDeco): CSSProperties => textFillCss(s, cqw) as CSSProperties

/** Unrevealed typewriter glyphs: keep their layout space, hide every paint —
 *  the CSS mirror of the ASS `\1a\3a\4a &HFF&` reveal (the pill, a separate
 *  box, stays; only fill/outline/shadow vanish — verified parity). */
function hiddenGlyphStyle(s: TextDeco): CSSProperties {
  const css = fillStyle(s)
  css.color = 'transparent'
  css.WebkitTextFillColor = 'transparent'
  css.textShadow = 'none'
  if (css.WebkitTextStroke) css.WebkitTextStroke = String(css.WebkitTextStroke).replace(/ .*$/, ' transparent')
  delete css.backgroundImage
  delete css.filter
  return css
}

/** Text glyphs with their fill/stroke/shadow, wrapped in a per-line pill when
 *  enabled (`textPillCss`; with a pill the glyph spans are `position:relative`
 *  so every line's text paints above every line's background).
 *
 *  `reveal` (typewriter: characters visible) and `litWords` (word-by-word
 *  karaoke: words highlighted) come from the shared `textAnimStateAt`, so the
 *  preview matches the ASS burn frame-for-frame. */
function StyledText({
  s,
  text,
  reveal,
  litWords
}: {
  s: TextDeco
  text: string
  reveal?: number | null
  litWords?: number | null
}): JSX.Element {
  let inner: React.ReactNode
  if (reveal != null && reveal < text.length) {
    inner = (
      <>
        <span style={fillStyle(s)}>{text.slice(0, reveal)}</span>
        <span style={hiddenGlyphStyle(s)}>{text.slice(reveal)}</span>
      </>
    )
  } else if (litWords != null) {
    let w = 0
    inner = text.split(/(\s+)/).map((tok, i) => {
      if (tok.length === 0 || /^\s+$/.test(tok)) return tok
      const lit = w++ < litWords
      return (
        <span key={i} style={{ ...fillStyle(s), opacity: lit ? 1 : KARAOKE_DIM_OPACITY }}>
          {tok}
        </span>
      )
    })
  } else {
    inner = <span style={fillStyle(s)}>{text}</span>
  }
  if (!s.pill.enabled) return <>{inner}</>
  return <span style={textPillCss(s.pill, cqw) as CSSProperties}>{inner}</span>
}

/**
 * ONE text block — a text layer and a caption render through this same box
 * (`textBoxCss`, the definition the export rasteriser and line layout share).
 * Centred on (x, y) by TRANSFORM, never `left`: an absolutely positioned box
 * only shrink-wraps into the space right of its `left`, which is how captions
 * (placed at `left: x%`) came to wrap at half the frame. Transform order is
 * translate → rotate (captions) → scale (text layers), so a scaled layer lays
 * out unscaled and grows as a whole, exactly as the export sizes it.
 */
function TextBlock({
  s,
  x,
  y,
  wrap,
  rotationDeg = 0,
  scale = 1,
  opacity,
  zIndex,
  className,
  onPointerDown,
  handleTarget,
  children
}: {
  s: Pick<TextStyleBase, 'fontFamily' | 'fontSizePx'>
  x: number
  y: number
  wrap: { widthPx?: number; wrapWidthPx: number }
  rotationDeg?: number
  scale?: number
  opacity?: number
  zIndex: number
  className: string
  onPointerDown: (e: ReactPointerEvent) => void
  /** Tag the box for the stage's resize-handle measuring (selected layer). */
  handleTarget?: boolean
  children: React.ReactNode
}): JSX.Element {
  const rot = rotationDeg ? ` rotate(${rotationDeg}deg)` : ''
  const sc = scale !== 1 ? ` scale(${scale})` : ''
  return (
    <div
      onPointerDown={onPointerDown}
      data-resizebox={handleTarget ? '' : undefined}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(calc(${cqw(x)} - 50%), calc(${cqh(y)} - 50%))${rot}${sc}`,
        transformOrigin: 'center',
        opacity: opacity != null && opacity < 1 ? opacity : undefined,
        zIndex,
        ...(textBoxCss(s, wrap, cqw) as CSSProperties)
      }}
      className={`select-none ${className}`}
    >
      {children}
    </div>
  )
}

/** Absolute box (in %) for a media layer, sized to its aspect at the layer's
 *  scale and centered on (x,y). Aspect-correct so there's no letterbox fill to
 *  occlude the layers behind it; anything past the frame is cropped by the stage. */
function mediaBox(layer: Layer, aspect: number): CSSProperties {
  const { w, h } = stretchedBox(aspect, layer.scale, layer.stretchX ?? 1, layer.stretchY ?? 1, LOGICAL)
  const rot = layerRotation(layer)
  return {
    position: 'absolute',
    left: pct(layer.x - w / 2, LOGICAL.width),
    top: pct(layer.y - h / 2, LOGICAL.height),
    width: pct(w, LOGICAL.width),
    height: pct(h, LOGICAL.height),
    // About the box centre (the default origin) — the export's `rotate` turns
    // the same sized box about the same point.
    ...(rot ? { transform: `rotate(${rot}deg)` } : {})
  }
}

/** Layers the rotate handle is offered on. Layouts and compound clips render
 *  as frame-shaped comps and ignore `rotationDeg` (backlogged). */
const canRotate = (layer: Layer): boolean =>
  layer.content.kind === 'video' || layer.content.kind === 'image' || layer.content.kind === 'text'

/** A layer that moves as a PATH on the canvas: a simple two-keyframe move, or
 *  a text layer with any keyframes (text only ever follows its motion). Drags
 *  and resizes shift the whole path instead of writing a keyframe. */
const onPath = (l: Layer): boolean =>
  !!l.keyframes?.length && (isSimpleMotion(l.keyframes) || l.content.kind === 'text')

/** `l` with its whole path — base position and every keyframe — moved by
 *  (dx, dy) from the drag-start snapshot `raw`. */
const movePath = (l: Layer, raw: Layer, dx: number, dy: number): Layer => ({
  ...l,
  x: raw.x + dx,
  y: raw.y + dy,
  keyframes: raw.keyframes ? shiftKeyframes(raw.keyframes, dx, dy) : raw.keyframes
})

/** A layer's rotation, normalised (0 = upright). @see shared/rotation.ts */
const layerRotation = (layer: Pick<Layer, 'rotationDeg'>): number =>
  layer.rotationDeg ? normalizeDeg(layer.rotationDeg) : 0

/** Mirror transform for flipped media, or undefined. */
const flipTransform = (c: { flipH?: boolean; flipV?: boolean }): string | undefined =>
  c.flipH || c.flipV ? `scaleX(${c.flipH ? -1 : 1}) scaleY(${c.flipV ? -1 : 1})` : undefined

/** CSS for the <video>/<img> filling its layer box (crop/color aware). */
function videoFillStyle(content: VideoContent, asset: MediaAsset | undefined): CSSProperties {
  const crop = content.crop
  const v = asset?.probe.video
  const col = content.color
  const filter = col
    ? `brightness(${1 + col.brightness}) contrast(${col.contrast}) saturate(${col.saturation})`
    : undefined
  if (crop && v) {
    return {
      position: 'absolute',
      width: `${(v.displayWidth / crop.w) * 100}%`,
      height: `${(v.displayHeight / crop.h) * 100}%`,
      left: `${-(crop.x / crop.w) * 100}%`,
      top: `${-(crop.y / crop.h) * 100}%`,
      objectFit: 'fill',
      maxWidth: 'none',
      filter
    }
  }
  return { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', filter }
}

const mediaAspect = (asset: MediaAsset | undefined, content: VideoContent | { crop?: undefined }): number => {
  if ('crop' in content && content.crop) return content.crop.w / content.crop.h
  const v = asset?.probe.video
  return v && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 1
}

/** The selected element's box as the handles need it: centre + UNROTATED size
 *  in logical px, its rotation, and the stage's screen px per logical px (for
 *  handle gaps that stay a constant on-screen size). */
interface MeasuredBox extends ResizeBox {
  rotationDeg: number
  pxPerLogical: number
}

/** Measure the selected element's box (tagged `data-resizebox`) via the stage.
 *  Text height is intrinsic so it must be read from the DOM; measuring media the
 *  same way keeps one path and tracks any live transform. The bounding rect of a
 *  ROTATED box is its screen-aligned hull, so only its centre is used (rotation
 *  is about the centre); size and angle come from the layout box and the
 *  element's own transform. */
function measureSelectedBox(stage: HTMLElement): MeasuredBox | null {
  const el = stage.querySelector('[data-resizebox]') as HTMLElement | null
  if (!el) return null
  const er = el.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  if (sr.width === 0 || stage.offsetWidth === 0) return null
  const s = LOGICAL.width / sr.width
  // Stage-local CSS px → screen px (the canvas may itself be scaled).
  const local = sr.width / stage.offsetWidth
  const t = getComputedStyle(el).transform
  const m = t && t !== 'none' ? new DOMMatrixReadOnly(t) : new DOMMatrixReadOnly()
  const own = Math.hypot(m.a, m.b) || 1
  return {
    cx: (er.left + er.width / 2 - sr.left) * s,
    cy: (er.top + er.height / 2 - sr.top) * s,
    w: el.offsetWidth * own * local * s,
    h: el.offsetHeight * own * local * s,
    rotationDeg: normalizeDeg((Math.atan2(m.b, m.a) * 180) / Math.PI),
    pxPerLogical: 1 / s
  }
}

// Media gets all 8 handles; text only the 4 corners + left/right sides (its
// height is automatic, so top/bottom handles have nothing to resize). Layouts
// get corners only — cells resolve through `scale` and ignore stretch, so edge
// handles would silently do nothing.
const MEDIA_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const TEXT_HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw', 'e', 'w']
const CORNER_HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw']
/** Resize cursor for a handle on a box rotated by `deg`: the handle's outward
 *  direction, turned with the box, picks the nearest of the four cursors. */
const HANDLE_DIR_DEG: Record<ResizeHandle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }
const RESIZE_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize']
const handleCursor = (h: ResizeHandle, deg = 0): string =>
  RESIZE_CURSORS[((Math.round((HANDLE_DIR_DEG[h] + deg) / 45) % 4) + 4) % 4]

/** On-screen gap between the box's top edge and the rotate handle. */
const ROTATE_HANDLE_GAP_PX = 22

/** The edge/corner resize handles drawn on the selected layer's box. Positioned
 *  in a non-scaled overlay over the FRAME (so they stay a constant size and are
 *  not clipped by it), driven by the measured box; `onStart` begins the drag for
 *  the grabbed handle.
 *
 *  A handle whose true spot lies outside the frame — a 9:16 clip in a 16:9 or
 *  square frame reaches well past the top and bottom — is pinned to the frame
 *  edge instead, so every clip stays resizable whatever its aspect. The drag
 *  math uses pointer DELTAS against the real box (`resizeBox`), so a pinned
 *  handle resizes exactly like the real corner would. */
function ResizeHandles({
  box,
  frame,
  handles,
  onStart,
  onRotateStart
}: {
  box: MeasuredBox
  frame: FrameRect
  handles: ResizeHandle[]
  onStart?: (e: ReactPointerEvent, handle: ResizeHandle) => void
  /** Present = the box can rotate: draws the rotate handle. */
  onRotateStart?: (e: ReactPointerEvent) => void
}): JSX.Element {
  const deg = box.rotationDeg
  return (
    <div className="pointer-events-none absolute inset-0 z-[450]">
      {onStart &&
        handles.map((h) => {
          // Handles sit on the ROTATED box, so they turn with it.
          const off = handleOffset(box.w, box.h, h, deg)
          const x = box.cx + off.x
          const y = box.cy + off.y
          const px = clamp(x, frame.x, frame.x + frame.w)
          const py = clamp(y, frame.y, frame.y + frame.h)
          return (
            <span
              key={h}
              data-handle={h}
              data-pinned={px !== x || py !== y ? '' : undefined}
              onPointerDown={(e) => onStart(e, h)}
              style={{ left: pct(px - frame.x, frame.w), top: pct(py - frame.y, frame.h), cursor: handleCursor(h, deg) }}
              className="pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-sky-500 bg-white shadow"
            />
          )
        })}
      {onRotateStart && <RotateHandle box={box} frame={frame} onStart={onRotateStart} />}
    </div>
  )
}

/**
 * THE rotate handle — one implementation for video, image, text and captions.
 * It hangs off the middle of the box's top edge, a constant on-screen gap
 * outward, and turns with the box (at 90° clockwise it sits to the box's right).
 * When that spot would fall outside the frame (a clip that fills a 9:16 frame
 * has its top edge ON the frame edge) it flips to just inside the edge instead,
 * so it is always grabbable — the rotate twin of the resize handles' pinning.
 */
function RotateHandle({
  box,
  frame,
  onStart
}: {
  box: MeasuredBox
  frame: FrameRect
  onStart: (e: ReactPointerEvent) => void
}): JSX.Element {
  const anchor = handleOffset(box.w, box.h, 'rot', box.rotationDeg)
  const gap = ROTATE_HANDLE_GAP_PX / box.pxPerLogical
  const up = rotateVec(0, -gap, box.rotationDeg)
  const inFrame = (x: number, y: number): boolean =>
    x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h
  let x = box.cx + anchor.x + up.x
  let y = box.cy + anchor.y + up.y
  const inward = !inFrame(x, y)
  if (inward) {
    x = box.cx + anchor.x - up.x
    y = box.cy + anchor.y - up.y
  }
  x = clamp(x, frame.x, frame.x + frame.w)
  y = clamp(y, frame.y, frame.y + frame.h)
  return (
    <span
      data-handle="rotate"
      data-inward={inward ? '' : undefined}
      title="Drag to rotate (Shift: 15° steps)"
      onPointerDown={onStart}
      style={{ left: pct(x - frame.x, frame.w), top: pct(y - frame.y, frame.h), cursor: 'grab' }}
      className="pointer-events-auto absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sky-500 bg-white text-[10px] leading-none text-sky-600 shadow"
    >
      ⟳
    </span>
  )
}

/**
 * The selected layer's straight-line move, drawn on the canvas: a dashed line
 * from the start point (hollow dot) to the end point (filled dot). Dragging a
 * dot moves that end only. Positions are canonical logical px, drawn over the
 * frame like the resize handles (and pinned to its edge the same way when an
 * end lies outside it).
 */
function MotionPath({
  motion,
  frame,
  onStart
}: {
  motion: { x0: number; y0: number; x1: number; y1: number }
  frame: FrameRect
  onStart: (e: ReactPointerEvent, end: 0 | 1) => void
}): JSX.Element {
  const dot = (end: 0 | 1): JSX.Element => {
    const x = end === 0 ? motion.x0 : motion.x1
    const y = end === 0 ? motion.y0 : motion.y1
    const px = clamp(x, frame.x, frame.x + frame.w)
    const py = clamp(y, frame.y, frame.y + frame.h)
    return (
      <span
        key={end}
        data-motion={end === 0 ? 'start' : 'end'}
        data-pinned={px !== x || py !== y ? '' : undefined}
        title={end === 0 ? 'Motion start — drag to move' : 'Motion end — drag to move'}
        onPointerDown={(e) => onStart(e, end)}
        style={{ left: pct(px - frame.x, frame.w), top: pct(py - frame.y, frame.h), cursor: 'move' }}
        className={`pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400 shadow ${
          end === 0 ? 'bg-black/40' : 'bg-amber-400'
        }`}
      />
    )
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-[440]" data-testid="motion-path">
      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
        preserveAspectRatio="none"
      >
        <line
          x1={motion.x0}
          y1={motion.y0}
          x2={motion.x1}
          y2={motion.y1}
          stroke="#fbbf24"
          strokeWidth={2}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {dot(0)}
      {dot(1)}
    </div>
  )
}

/** A hidden <audio> that follows the timeline clock for one audio clip. */
function AudioFollower({
  clip,
  asset,
  src,
  time,
  playing
}: {
  clip: AudioClip
  asset: MediaAsset
  src: string
  time: number
  playing: boolean
}): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const eo = effectiveOut(clip, asset.probe.durationSec)
  const active = time >= clip.startSec - 0.001 && time < clip.startSec + (eo - clip.inSec)
  const target = clip.inSec + (time - clip.startSec)

  // Element `volume` clamps at 1.0, so a boosted clip is routed through a
  // GainNode to match the export's `volume=` filter. @see lib/mediaGain.ts
  // A muted clip is held at gain 0 rather than skipped, so it keeps following
  // the playhead and unmuting mid-playback is instant. The export reaches the
  // same silence by dropping the clip — `audioClipAudible` is the shared call.
  useMediaGain(ref, clip.gainDb, !audioClipAudible(clip))

  useEffect(() => {
    const a = ref.current
    if (!a) return
    if (playing && active) {
      if (Math.abs(a.currentTime - target) > 0.3) a.currentTime = target
      if (a.paused) void a.play().catch(() => {})
    } else {
      if (!a.paused) a.pause()
      if (active && a.readyState >= 1 && Math.abs(a.currentTime - target) > 0.05) a.currentTime = target
    }
  }, [playing, active, target])

  // `data-testid` distinguishes the mix follower from the library card's own
  // preview player (`ClipCard`), which is a separate <audio> on the same source.
  return (
    <audio
      ref={ref}
      data-testid="audio-follower"
      // Before `src` on purpose: React sets attributes in prop order, and an
      // element that fetches once without this is tainted for good — a GainNode
      // on it would emit silence. @see lib/mediaGain.ts
      crossOrigin="anonymous"
      src={src}
      preload="auto"
    />
  )
}

/**
 * A composition's AUDIO TRACK: one follower `<audio>` per clip (the browser
 * mixes them). The single implementation, used both for the composition being
 * edited and — recursively, through `CompFill` — for every nested comp on
 * screen: a comp's audio track has to reach the mix the same way its pictures
 * reach the frame. `time` is LOCAL to that composition.
 */
function CompAudioTrack({
  clips,
  assetById,
  time,
  playing
}: {
  clips: AudioClip[]
  assetById: Map<string, MediaAsset>
  time: number
  playing: boolean
}): JSX.Element {
  return (
    <>
      {clips.map((a) => {
        const asset = assetById.get(a.mediaId)
        if (!asset?.proxyReady) return null
        const src = asset.probe.video ? videoProxyUrl(asset) : audioUrl(asset.id)
        return (
          <AudioFollower key={a.id} clip={a} asset={asset} src={src} time={time} playing={playing} />
        )
      })}
    </>
  )
}

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
  muted = false
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
  const speed = ramped
    ? videoSpeedAtSource(content, target)
    : videoSpeed(content)
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
              <img src={thumbUrl(asset.id)} alt="" className="h-full w-full object-cover opacity-40" />
            </div>
          )
        }
        // Empty / out-of-span cell: outline it while selected so the slots show.
        return selected ? (
          <div key={i} style={rel} className="border border-dashed border-white/25" />
        ) : null
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
function StackLayer({
  rawLayer,
  z,
  time,
  playing,
  assetById,
  selected,
  onMoveDown,
  depth = 1,
  muted = false
}: {
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
}): JSX.Element | null {
  const frame = useContext(FrameCtx)
  const layer = withKeyframedTransform(rawLayer, time)

        // Keyframed opacity (video/image): same shared interpolation the export
        // bakes into its sendcmd `aa` ramp — applied on the layer box.
        const kfOp = layerTransformAt(rawLayer, time).opacity

        if (layer.content.kind === 'video') {
          const content = layer.content
          const asset = assetById.get(content.mediaId)
          const box = {
            ...mediaBox(layer, mediaAspect(asset, content)),
            zIndex: z,
            ...(kfOp < 1 ? { opacity: kfOp } : {})
          }
          if (!asset?.proxyReady || !asset.probe.video) {
            return (
              <div
                key={layer.id}
                style={box}
                onPointerDown={onMoveDown}
                data-resizebox={selected ? '' : undefined}
                className={`flex items-center justify-center overflow-hidden bg-zinc-900/70 text-[10px] text-zinc-500 ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : ''}`}
              >
                {asset ? (
                  <img src={thumbUrl(asset.id)} alt="" className="h-full w-full object-cover opacity-40" />
                ) : (
                  'missing'
                )}
              </div>
            )
          }
          return (
            <VideoLayerView
              key={layer.id}
              layer={layer}
              content={content}
              asset={asset}
              time={time}
              playing={playing}
              selected={selected}
              boxStyle={box}
              onMoveDown={onMoveDown}
              muted={muted}
            />
          )
        }

        if (layer.content.kind === 'image') {
          const content = layer.content
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
            ...(kfOp < 1 ? { opacity: kfOp } : {})
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
              key={layer.id}
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
                <img src={imageUrl(content.mediaId)} alt="" draggable={false} style={imgStyle} />
              </div>
            </div>
          )
        }

        if (layer.content.kind === 'layout') {
          const content = layer.content
          // The wrapper is the layer's transformed FULL-FRAME rect; cells sit
          // inside at their plain preset fractions (the wrapper carries the
          // move/zoom) — same numbers `layoutCellRect` gives the export.
          const frameRect = layoutCellRect(layer, FULL_CELL, frame)
          const box: CSSProperties = {
            position: 'absolute',
            left: pct(frameRect.x, LOGICAL.width),
            top: pct(frameRect.y, LOGICAL.height),
            width: pct(frameRect.w, LOGICAL.width),
            height: pct(frameRect.h, LOGICAL.height),
            zIndex: z
          }
          return (
            <LayoutLayerView
              key={layer.id}
              layer={layer}
              content={content}
              assetById={assetById}
              time={time}
              playing={playing}
              selected={selected}
              boxStyle={box}
              onMoveDown={onMoveDown}
              depth={depth}
              muted={muted}
            />
          )
        }

        if (layer.content.kind === 'compound') {
          // Like a layout, the box is the layer-transformed FULL-FRAME rect;
          // the nested comp fills it on its own local clock (comp t=0 at the
          // layer start). Compounds ignore transform keyframes (v1 rule).
          const frameRect = layoutCellRect(layer, FULL_CELL, frame)
          const box: CSSProperties = {
            position: 'absolute',
            left: pct(frameRect.x, LOGICAL.width),
            top: pct(frameRect.y, LOGICAL.height),
            width: pct(frameRect.w, LOGICAL.width),
            height: pct(frameRect.h, LOGICAL.height),
            zIndex: z,
            containerType: 'size' as const
          }
          return (
            <div
              style={box}
              onPointerDown={onMoveDown}
              data-resizebox={selected ? '' : undefined}
              className={`overflow-hidden ${
                selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : 'cursor-pointer'
              }`}
            >
              <CompFill
                comp={layer.content.comp}
                time={time - layer.startSec}
                playing={playing}
                assetById={assetById}
                depth={depth + 1}
                muted={muted}
              />
            </div>
          )
        }

        // Text layer — the same `TextBlock` a caption renders through. Explicit
        // `widthPx` (from a side-resize) fixes the wrap width; otherwise it hugs
        // content up to the shared frame-relative wrap width. Animation state
        // comes from the shared per-frame helper (playhead-driven, so
        // scrub/pause stay exact — never CSS animations).
        const content = layer.content
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
              typewriterSec:
                textAnim?.in === 'typewriter' ? clampAnimWindows(textAnim, layerDur).inSec : 0
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
            key={layer.id}
            s={content}
            x={pos.x + slide.x}
            y={pos.y + slide.y}
            wrap={{ widthPx: content.widthPx, wrapWidthPx: textWrapWidth(frame.w) }}
            rotationDeg={rot}
            scale={layer.scale * anim.scale}
            opacity={anim.opacity}
            zIndex={z}
            onPointerDown={onMoveDown}
            handleTarget={selected}
            className={`cursor-move ${selected ? 'outline-dashed outline-2 outline-sky-400' : ''}`}
          >
            <StyledText s={content} text={content.text} reveal={anim.revealChars} litWords={anim.litWords} />
            {sparkleEffect && (
              <Sparkles sparkles={sparkles} color={sparkleEffect.color} tLocal={time - layer.startSec} />
            )}
          </TextBlock>
        )
}

/** The same four-point star the ASS burn draws (`SPARKLE_PATH`), as SVG. Both
 *  are a radius-10 unit star, so preview and export show the same shape. */
const SPARKLE_SVG_PATH = 'M0,-10 L2,-2 L10,0 L2,2 L0,10 L-2,2 L-10,0 L-2,-2 Z'

/**
 * The sparkle layer of a text overlay, drawn ABOVE the glyphs (matching the
 * burn, which puts sparkles on ASS Layer 1). Positions come from the shared
 * `sparklesFor`, and each sparkle's twinkle from `sparkleStateAt` — playhead
 * driven like every other animation here, so scrubbing stays exact.
 *
 * Offsets are placed from the text block's centre in `cqw`/`cqh`, INSIDE the
 * layer's scaled box, so the layer scale multiplies them exactly as the export
 * does by computing sparkles at the output-scaled font size. Both dimensions
 * use `cqw` so the star stays round (logical px are square).
 */
function Sparkles({
  sparkles,
  color,
  tLocal
}: {
  sparkles: Sparkle[]
  color: string
  tLocal: number
}): JSX.Element {
  return (
    <>
      {sparkles.map((s, i) => {
        const st = sparkleStateAt(s, tLocal)
        if (st.opacity <= 0) return null
        return (
          <svg
            key={i}
            viewBox="-10 -10 20 20"
            aria-hidden
            data-sparkle=""
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: cqw(s.sizePx * 2),
              height: cqw(s.sizePx * 2),
              transform: `translate(-50%,-50%) translate(${cqw(s.x)}, ${cqh(s.y)}) rotate(${s.rotDeg}deg) scale(${st.scale})`,
              opacity: st.opacity,
              pointerEvents: 'none',
              overflow: 'visible'
            }}
          >
            <path d={SPARKLE_SVG_PATH} fill={color} />
          </svg>
        )
      })}
    </>
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
function CompFill({
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
        {!muted && (
          <CompAudioTrack clips={comp.audioClips} assetById={assetById} time={time} playing={playing} />
        )}
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

  // Drag a layer to move it (logical coords), one undo step on release.
  const startLayerMove = (e: ReactPointerEvent, layer: Layer): void => {
    e.stopPropagation()
    e.preventDefault()
    // Picks the whole link group, like the timeline — a group is never partly
    // selected, or the next timeline drag would move one member on its own.
    useUi.getState().selectTile(useProject.getState().project, { kind: 'layer', id: layer.id })
    const stage = stageRef.current
    if (!stage) return
    const scale = LOGICAL.width / stage.getBoundingClientRect().width
    const startX = e.clientX
    const startY = e.clientY
    // A layer on a PATH (a simple two-keyframe move, or any text keyframes)
    // moves as a whole: the drag shifts both ends. Otherwise, on a keyframed
    // layer, dragging writes/updates a keyframe at the playhead (standard editor
    // behavior) instead of the base transform, which keyframes override.
    // `layer.x/y` are already the effective values at `time`.
    const raw = getActiveComp()?.layers.find((l) => l.id === layer.id) ?? layer
    const path = onPath(raw)
    const kfd = !path && !!layer.keyframes?.length && layer.content.kind !== 'text'
    const t0 = usePlayback.getState().time
    const kfT = clamp(t0 - layer.startSec, 0, Math.max(0, layer.endSec - layer.startSec))
    const tr0 = layerTransformAt(layer, t0)
    const kfScale = tr0.scale
    // A drag writes position — the keyframe keeps the opacity in effect there.
    const kfExtra = tr0.opacity < 1 ? { opacity: tr0.opacity } : {}
    startDragWithUndo((ev) => {
      const nx = layer.x + (ev.clientX - startX) * scale
      const ny = layer.y + (ev.clientY - startY) * scale
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => {
          if (l.id !== layer.id) return l
          if (path) return movePath(l, raw, nx - layer.x, ny - layer.y)
          if (kfd) {
            return { ...l, keyframes: upsertKeyframe(layer.keyframes, { tSec: kfT, x: nx, y: ny, scale: kfScale, ...kfExtra }) }
          }
          return { ...l, x: nx, y: ny }
        })
      }))
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
    const s = LOGICAL.width / stage.getBoundingClientRect().width
    const startX = e.clientX
    const startY = e.clientY
    const isCorner = handle.length === 2
    const isText = layer.content.kind === 'text'
    // Corner-resizing a keyframed layer writes a keyframe at the playhead
    // (like a canvas move) — unless it is on a PATH, which shifts (and, from a
    // corner, scales) as a whole so a simple move stays two keyframes.
    // `layer.scale` is already the effective value.
    const raw = getActiveComp()?.layers.find((l) => l.id === layer.id) ?? layer
    const path = onPath(raw)
    const kfd = !path && !!layer.keyframes?.length && !isText
    const kfT = clamp(
      usePlayback.getState().time - layer.startSec,
      0,
      Math.max(0, layer.endSec - layer.startSec)
    )
    const rOp = layerTransformAt(layer, usePlayback.getState().time).opacity
    const kfExtra = rOp < 1 ? { opacity: rOp } : {}
    startDragWithUndo((ev) => {
      const dx = (ev.clientX - startX) * s
      const dy = (ev.clientY - startY) * s
      // Turned into the box's own axes, so a rotated edge stretches along its side.
      const nb = resizeRotatedBox(startBox, handle, dx, dy, isCorner, startBox.rotationDeg)
      // The centre moves by the box's shift — BOTH axes, since on a rotated box
      // even a side handle moves the centre diagonally. Applied as a delta, so a
      // measured centre that sits off the layer's own (a text slide mid-way)
      // can't leak into the position.
      const x = layer.x + (nb.cx - startBox.cx)
      const y = layer.y + (nb.cy - startBox.cy)
      const pathed = (l: Layer): Layer => {
        if (!path) return l
        const f = isCorner ? nb.w / startBox.w : 1
        const moved = movePath(l, raw, x - layer.x, y - layer.y)
        return f === 1 ? moved : { ...moved, keyframes: moved.keyframes?.map((k) => ({ ...k, scale: clamp(k.scale * f, 0.05, 8) })) }
      }
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l0) => {
          if (l0.id !== layer.id) return l0
          const l = pathed(l0)
          if (isCorner) {
            const ns = clamp(layer.scale * (nb.w / startBox.w), 0.05, 8)
            if (kfd) {
              return { ...l, keyframes: upsertKeyframe(layer.keyframes, { tSec: kfT, x, y, scale: ns, ...kfExtra }) }
            }
            return { ...l, ...(path ? {} : { x, y }), scale: path && !isText ? raw.scale : ns }
          }
          const xy = path ? {} : { x, y }
          if (isText && l.content.kind === 'text') {
            // widthPx is the pre-scale wrap width; the measured box is post-scale.
            return { ...l, ...xy, content: { ...l.content, widthPx: nb.w / layer.scale } }
          }
          if (handle === 'e' || handle === 'w') {
            return { ...l, ...xy, stretchX: (layer.stretchX ?? 1) * (nb.w / startBox.w) }
          }
          return { ...l, ...xy, stretchY: (layer.stretchY ?? 1) * (nb.h / startBox.h) }
        })
      }))
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
    const scale = LOGICAL.width / stage.getBoundingClientRect().width
    const startX = e.clientX
    const startY = e.clientY
    startDragWithUndo((ev, before) => {
      const base = effectiveCaptionStyle(before.captions, seg)
      const nx = base.x + (ev.clientX - startX) * scale
      const ny = base.y + (ev.clientY - startY) * scale
      useProject.getState().liveUpdate((p) => {
        if (global) return { ...p, captions: { ...p.captions, style: { ...p.captions.style, x: nx, y: ny } } }
        return {
          ...p,
          captions: {
            ...p.captions,
            segments: p.captions.segments.map((s) =>
              s.id === seg.id ? { ...s, style: { ...(s.style ?? p.captions.style), x: nx, y: ny } } : s
            )
          }
        }
      })
    })
  }

  // Rotate-handle drag — THE one rotate interaction; `apply` is the only part
  // that differs between a layer and a caption. Relative to where the drag
  // began (no jump on grab), snapping near right angles; Shift steps by 15°.
  const startRotate = (
    e: ReactPointerEvent,
    startDeg: number,
    apply: (deg: number) => void
  ): void => {
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
    startRotate(e, layerRotation(layer), (deg) =>
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => (l.id === layer.id ? { ...l, rotationDeg: deg || undefined } : l))
      }))
    )

  // Drag one end of a simple move (`MotionPath` dot): that keyframe's position
  // follows the pointer; the other end, and both times, stay put.
  const startMotionEndDrag = (e: ReactPointerEvent, layer: Layer, end: 0 | 1): void => {
    e.stopPropagation()
    e.preventDefault()
    const stage = stageRef.current
    const kfs = layer.keyframes
    if (!stage || !isSimpleMotion(kfs)) return
    const s = LOGICAL.width / stage.getBoundingClientRect().width
    const sortedKfs = [...kfs].sort((a, b) => a.tSec - b.tSec)
    const k0 = sortedKfs[end]
    const startX = e.clientX
    const startY = e.clientY
    startDragWithUndo((ev) => {
      const moved = { ...k0, x: k0.x + (ev.clientX - startX) * s, y: k0.y + (ev.clientY - startY) * s }
      const next = end === 0 ? [moved, sortedKfs[1]] : [sortedKfs[0], moved]
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => (l.id === layer.id ? { ...l, keyframes: next } : l))
      }))
    })
  }

  // Same rule as a caption drag: lane-wide mode turns the global style,
  // otherwise this caption gets (or updates) its own override.
  const startCaptionRotate = (e: ReactPointerEvent, seg: CaptionSegment): void => {
    const global = useUi.getState().captionsGlobalSelected
    const comp = getActiveComp()
    if (!comp) return
    startRotate(e, effectiveCaptionStyle(comp.captions, seg).rotationDeg, (deg) =>
      useProject.getState().liveUpdate((p) => {
        if (global) return { ...p, captions: { ...p.captions, style: { ...p.captions.style, rotationDeg: deg } } }
        return {
          ...p,
          captions: {
            ...p.captions,
            segments: p.captions.segments.map((x) =>
              x.id === seg.id ? { ...x, style: { ...(x.style ?? p.captions.style), rotationDeg: deg } } : x
            )
          }
        }
      })
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
          <div ref={stageRef} data-testid="preview-canvas" style={frameCanvasStyle(frame)} onPointerDown={deselectOnBackground}>
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
        {selectedLayer && canRotate(selectedLayer) && isSimpleMotion(selectedLayer.keyframes) && (
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
            handles={
              selectedLayer.content.kind === 'text'
                ? TEXT_HANDLES
                : selectedLayer.content.kind === 'layout'
                  ? CORNER_HANDLES
                  : MEDIA_HANDLES
            }
            onStart={(e, handle) => startLayerResize(e, withKeyframedTransform(selectedLayer, time), handle)}
            onRotateStart={canRotate(selectedLayer) ? (e) => startLayerRotate(e, selectedLayer) : undefined}
          />
        )}
        {/* Captions are text: they get the same rotate handle (no resize —
            their size is the style's font size). */}
        {handleCaption && handleBox && (
          <ResizeHandles box={handleBox} frame={frame} handles={[]} onRotateStart={(e) => startCaptionRotate(e, handleCaption)} />
        )}
      </div>
    </FrameCtx.Provider>
  )
}
