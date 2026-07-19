import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { AudioClip, CaptionSegment, Layer, LayoutContent, PillStyle, TextStyleBase, VideoContent } from '@shared/project'
import { audioClipEnd, effectiveCaptionStyle, effectiveOut, pillRadiusPx, videoSpeed } from '@shared/project'
import { hasSpeedRamp, videoSpeedAtSource } from '@shared/speed'
import { cellSpan, layoutCellRect } from '@shared/layouts'
import type { MediaAsset } from '@shared/media'
import { fontCssFamily } from '@shared/fonts'
import {
  effectiveImageAspect,
  isFrozenAt,
  layersAtTime,
  layerTransformAt,
  makeVideoLayer,
  resizeBox,
  stretchedBox,
  upsertKeyframe,
  videoSourceTime,
  visualDuration,
  type ResizeBox,
  type ResizeHandle
} from '@shared/layers'
import { effectiveTextAnimation, KARAOKE_DIM_OPACITY, textAnimStateAt } from '@shared/textAnim'
import { LOGICAL, SAFE_ZONES } from '@/lib/coords'
import { startDragWithUndo } from '@/lib/pointerDrag'
import { audioUrl, imageUrl, thumbUrl, videoProxyUrl } from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
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
 *  fonts/strokes/shadows scale with the stage like the burned output does. */
const cqw = (px: number): string => `${(px / LOGICAL.width) * 100}cqw`
/** Vertical counterpart of `cqw`, for positioning by the logical y axis. */
const cqh = (px: number): string => `${(px / LOGICAL.height) * 100}cqh`

/** The decoration knobs shared by a text overlay and a caption (the fill +
 *  pill/stroke/shadow subset of the shared `TextStyleBase`). */
type TextDeco = Pick<TextStyleBase, 'color' | 'pill' | 'stroke' | 'shadow' | 'gradient'>

/** Fill (flat color or gradient) + stroke + shadow for the text glyphs. Mirrors
 *  the export: gradient via background-clip:text, stroke outside the glyph via
 *  paint-order, shadow as a diagonal text-shadow. */
function fillStyle(s: TextDeco): CSSProperties {
  const css: CSSProperties = {}
  if (s.gradient) {
    css.backgroundImage = `linear-gradient(${s.gradient.angle}deg, ${s.gradient.from}, ${s.gradient.to})`
    css.WebkitBackgroundClip = 'text'
    css.backgroundClip = 'text'
    css.color = 'transparent'
    css.WebkitTextFillColor = 'transparent'
  } else {
    css.color = s.color
  }
  if (s.stroke && s.stroke.widthPx > 0) {
    css.WebkitTextStroke = `${cqw(s.stroke.widthPx)} ${s.stroke.color}`
    css.paintOrder = 'stroke fill'
  }
  if (s.shadow && (s.shadow.distancePx > 0 || s.shadow.blur > 0)) {
    css.textShadow = `${cqw(s.shadow.distancePx)} ${cqw(s.shadow.distancePx)} ${cqw(s.shadow.blur)} ${s.shadow.color}`
  } else if (!s.pill.enabled && !s.stroke) {
    // Default legibility shadow when nothing else separates the text.
    css.textShadow = '0 0.25cqw 0.6cqw rgba(0,0,0,0.9), 0 0 0.3cqw rgba(0,0,0,0.9)'
  }
  return css
}

/** The per-line pill behind the text: an inline wrapper, so box-decoration-break
 *  clones a padded, rounded background onto EACH wrapped line — lines of
 *  different lengths get different-width pills. */
function pillWrapStyle(pill: PillStyle): CSSProperties {
  return {
    background: pill.color,
    padding: cqw(pill.padPx),
    borderRadius: cqw(pillRadiusPx(pill.padPx)),
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone'
  }
}

/** Unrevealed typewriter glyphs: keep their layout space, hide every paint —
 *  the CSS mirror of the ASS `\1a\3a\4a &HFF&` reveal (with a pill, the box
 *  stays; only fill/stroke/shadow vanish — verified parity). */
function hiddenGlyphStyle(s: TextDeco): CSSProperties {
  const css = fillStyle(s)
  css.color = 'transparent'
  css.WebkitTextFillColor = 'transparent'
  css.textShadow = 'none'
  if (css.WebkitTextStroke) css.WebkitTextStroke = String(css.WebkitTextStroke).replace(/ .*$/, ' transparent')
  delete css.backgroundImage
  return css
}

/** Text glyphs with their fill/stroke/shadow, wrapped in a per-line pill when
 *  enabled. The inner text span is `position:relative` so ALL glyphs paint in the
 *  positioned phase — above every line's background. Without it, a lower line's
 *  padded background bleeds up into the line above and paints OVER its text
 *  (the reported multi-line bug). Mirrored in the export (`textImage.buildHtml`).
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
  const rel = (css: CSSProperties): CSSProperties => (s.pill.enabled ? { ...css, position: 'relative' } : css)
  let inner: React.ReactNode
  if (reveal != null && reveal < text.length) {
    inner = (
      <>
        <span style={rel(fillStyle(s))}>{text.slice(0, reveal)}</span>
        <span style={rel(hiddenGlyphStyle(s))}>{text.slice(reveal)}</span>
      </>
    )
  } else if (litWords != null) {
    let w = 0
    inner = text.split(/(\s+)/).map((tok, i) => {
      if (tok.length === 0 || /^\s+$/.test(tok)) return tok
      const lit = w++ < litWords
      return (
        <span key={i} style={rel({ ...fillStyle(s), opacity: lit ? 1 : KARAOKE_DIM_OPACITY })}>
          {tok}
        </span>
      )
    })
  } else {
    inner = <span style={rel(fillStyle(s))}>{text}</span>
  }
  if (!s.pill.enabled) return <>{inner}</>
  return <span style={pillWrapStyle(s.pill)}>{inner}</span>
}

/** Absolute box (in %) for a media layer, sized to its aspect at the layer's
 *  scale and centered on (x,y). Aspect-correct so there's no letterbox fill to
 *  occlude the layers behind it; anything past the frame is cropped by the stage. */
function mediaBox(layer: Layer, aspect: number): CSSProperties {
  const { w, h } = stretchedBox(aspect, layer.scale, layer.stretchX ?? 1, layer.stretchY ?? 1, LOGICAL)
  return {
    position: 'absolute',
    left: pct(layer.x - w / 2, LOGICAL.width),
    top: pct(layer.y - h / 2, LOGICAL.height),
    width: pct(w, LOGICAL.width),
    height: pct(h, LOGICAL.height)
  }
}

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

/** Measure the selected layer's on-screen box (tagged `data-resizebox`) in logical
 *  px, via the stage. Text height is intrinsic so it must be read from the DOM;
 *  measuring media the same way keeps one path and tracks any live transform. */
function measureSelectedBox(stage: HTMLElement): ResizeBox | null {
  const el = stage.querySelector('[data-resizebox]') as HTMLElement | null
  if (!el) return null
  const er = el.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  if (sr.width === 0) return null
  const s = LOGICAL.width / sr.width
  return {
    cx: (er.left + er.width / 2 - sr.left) * s,
    cy: (er.top + er.height / 2 - sr.top) * s,
    w: er.width * s,
    h: er.height * s
  }
}

// Media gets all 8 handles; text only the 4 corners + left/right sides (its
// height is automatic, so top/bottom handles have nothing to resize). Layouts
// get corners only — cells resolve through `scale` and ignore stretch, so edge
// handles would silently do nothing.
const MEDIA_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const TEXT_HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw', 'e', 'w']
const CORNER_HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw']
const handleCursor = (h: ResizeHandle): string =>
  h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'

/** The edge/corner resize handles drawn on the selected layer's box. Positioned
 *  in a non-scaled overlay (so they stay a constant size), driven by the measured
 *  box; `onStart` begins the drag for the grabbed handle. */
function ResizeHandles({
  box,
  handles,
  onStart
}: {
  box: ResizeBox
  handles: ResizeHandle[]
  onStart: (e: ReactPointerEvent, handle: ResizeHandle) => void
}): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-[450]">
      {handles.map((h) => {
        const x = box.cx + (h.includes('e') ? box.w / 2 : h.includes('w') ? -box.w / 2 : 0)
        const y = box.cy + (h.includes('s') ? box.h / 2 : h.includes('n') ? -box.h / 2 : 0)
        return (
          <span
            key={h}
            onPointerDown={(e) => onStart(e, h)}
            style={{ left: pct(x, LOGICAL.width), top: pct(y, LOGICAL.height), cursor: handleCursor(h) }}
            className="pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-sky-500 bg-white shadow"
          />
        )
      })}
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

  useEffect(() => {
    const a = ref.current
    if (a) a.volume = Math.min(1, Math.max(0, Math.pow(10, clip.gainDb / 20)))
  }, [clip.gainDb])

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

  return <audio ref={ref} src={src} preload="auto" />
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
  onMoveDown
}: {
  layer: Layer
  content: VideoContent
  asset: MediaAsset
  time: number
  playing: boolean
  selected: boolean
  boxStyle: CSSProperties
  onMoveDown: (e: ReactPointerEvent) => void
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
      <video
        ref={ref}
        src={videoProxyUrl(asset)}
        muted={content.mute || ramped}
        playsInline
        style={fill}
        onLoadedMetadata={() => {
          const v = ref.current
          if (v) {
            v.currentTime = target
            v.muted = content.mute || ramped
          }
        }}
      />
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
  onMoveDown
}: {
  layer: Layer
  content: LayoutContent
  assetById: Map<string, MediaAsset>
  time: number
  playing: boolean
  selected: boolean
  boxStyle: CSSProperties
  onMoveDown: (e: ReactPointerEvent) => void
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
        const asset = cell.mediaId ? assetById.get(cell.mediaId) : undefined
        const effSpan = Math.min(cellSpan(cell), window)
        if (asset?.proxyReady && asset.probe.video && local >= 0 && local < effSpan) {
          return (
            <LayoutCellVideo
              key={i}
              asset={asset}
              mute={cell.mute}
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
 * The 9:16 playback surface. Composites the unified layer stack (multiple videos
 * /images/text at once), driven by a single wall-clock master so several videos
 * can play together. Layers move/zoom in the logical 1080x1920 space and are
 * cropped by the stage; uncovered areas are black.
 */
export function PreviewStage(): JSX.Element {
  const project = useProject((s) => s.project)
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
      return [makeVideoLayer('__preview__', selectedAsset.id, 0, selectedAsset.probe.durationSec)]
    }
    return EMPTY_LAYERS
  }, [layers, selectedAsset])

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
    useUi.getState().selectLayer(layer.id)
    const stage = stageRef.current
    if (!stage) return
    const scale = LOGICAL.width / stage.getBoundingClientRect().width
    const startX = e.clientX
    const startY = e.clientY
    // On a keyframed layer, dragging writes/updates a keyframe at the playhead
    // (standard editor behavior) instead of the base transform, which keyframes
    // override. `layer.x/y` are already the effective values at `time`.
    const kfd = !!layer.keyframes?.length && layer.content.kind !== 'text'
    const t0 = usePlayback.getState().time
    const kfT = clamp(t0 - layer.startSec, 0, Math.max(0, layer.endSec - layer.startSec))
    const kfScale = layerTransformAt(layer, t0).scale
    startDragWithUndo((ev) => {
      const nx = layer.x + (ev.clientX - startX) * scale
      const ny = layer.y + (ev.clientY - startY) * scale
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => {
          if (l.id !== layer.id) return l
          if (kfd) {
            return { ...l, keyframes: upsertKeyframe(layer.keyframes, { tSec: kfT, x: nx, y: ny, scale: kfScale }) }
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
    // (like a canvas move). `layer.scale` is already the effective value.
    const kfd = !!layer.keyframes?.length && !isText
    const kfT = clamp(
      usePlayback.getState().time - layer.startSec,
      0,
      Math.max(0, layer.endSec - layer.startSec)
    )
    startDragWithUndo((ev) => {
      const dx = (ev.clientX - startX) * s
      const dy = (ev.clientY - startY) * s
      const nb = resizeBox(startBox, handle, dx, dy, isCorner)
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => {
          if (l.id !== layer.id) return l
          if (isCorner) {
            const ns = clamp(layer.scale * (nb.w / startBox.w), 0.05, 8)
            if (kfd) {
              return { ...l, keyframes: upsertKeyframe(layer.keyframes, { tSec: kfT, x: nb.cx, y: nb.cy, scale: ns }) }
            }
            return { ...l, x: nb.cx, y: nb.cy, scale: ns }
          }
          if (isText && l.content.kind === 'text') {
            // widthPx is the pre-scale wrap width; the measured box is post-scale.
            return { ...l, x: nb.cx, content: { ...l.content, widthPx: nb.w / layer.scale } }
          }
          if (handle === 'e' || handle === 'w') {
            return { ...l, x: nb.cx, stretchX: (layer.stretchX ?? 1) * (nb.w / startBox.w) }
          }
          return { ...l, y: nb.cy, stretchY: (layer.stretchY ?? 1) * (nb.h / startBox.h) }
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

  const activeLayers = layersAtTime(previewLayers, time).filter((l) => !l.hidden)
  const selectedLayer = activeLayers.find((l) => l.id === selectedLayerId) ?? null

  // Measure the selected layer's box for the resize handles. Re-runs whenever the
  // layer object changes (incl. each live drag frame) and on stage resize, so the
  // handles track the box. `useLayoutEffect` reads the freshly committed DOM.
  const [handleBox, setHandleBox] = useState<ResizeBox | null>(null)
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || !selectedLayer) {
      setHandleBox(null)
      return undefined
    }
    const update = (): void => setHandleBox(measureSelectedBox(stage))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
    // A keyframed layer's box moves with the playhead — re-measure per tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayer, selectedLayer?.keyframes?.length ? time : 0])

  // All captions on screen now (audio clips are captioned independently, so two
  // overlapping clips can show two captions at once — stack them).
  const activeCaptions = captions?.enabled
    ? captions.segments.filter((s) => s.enabled && time >= s.startSec && time < s.endSec)
    : []
  const hasContent = previewLayers.length > 0

  return (
    <div
      ref={stageRef}
      style={{ containerType: 'size' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) useUi.getState().selectLayer(null)
      }}
      className="relative isolate aspect-[9/16] h-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
    >
      {/* Audio track: one follower <audio> per clip (the browser mixes them) */}
      {audioClips.map((a) => {
        const asset = assetById.get(a.mediaId)
        if (!asset?.proxyReady) return null
        const src = asset.probe.video ? videoProxyUrl(asset) : audioUrl(asset.id)
        return <AudioFollower key={a.id} clip={a} asset={asset} src={src} time={time} playing={playing} />
      })}

      {/* The composited layer stack, back (index 0) → front. */}
      {activeLayers.map((rawLayer, i) => {
        const layer = withKeyframedTransform(rawLayer, time)
        const z = 10 + i
        const selected = layer.id === selectedLayerId
        const onMoveDown = (e: ReactPointerEvent): void => startLayerMove(e, layer)

        if (layer.content.kind === 'video') {
          const content = layer.content
          const asset = assetById.get(content.mediaId)
          const box = { ...mediaBox(layer, mediaAspect(asset, content)), zIndex: z }
          if (!asset?.proxyReady || !asset.probe.video) {
            return (
              <div
                key={layer.id}
                style={box}
                onPointerDown={onMoveDown}
                className="flex items-center justify-center overflow-hidden bg-zinc-900/70 text-[10px] text-zinc-500"
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
          const box = { ...mediaBox(layer, aspect), zIndex: z, containerType: 'size' as const }
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
          const frameRect = layoutCellRect(layer, { x: 0, y: 0, w: LOGICAL.width, h: LOGICAL.height })
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
            />
          )
        }

        // Text layer. Position via transform (left/top = 0) so the wrap width is
        // independent of x — anchoring by `left:x%` made the box narrower as it
        // moved right. Explicit `widthPx` (from a side-resize) fixes the wrap
        // width; otherwise it hugs content up to a position-independent max.
        // Animation state comes from the shared per-frame helper (playhead-
        // driven, so scrub/pause stay exact — never CSS animations).
        const content = layer.content
        const anim = textAnimStateAt(
          effectiveTextAnimation(content),
          layer.startSec,
          layer.endSec,
          content.text,
          time
        )
        return (
          <div
            key={layer.id}
            onPointerDown={onMoveDown}
            data-resizebox={selected ? '' : undefined}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: `translate(calc(${cqw(layer.x)} - 50%), calc(${cqh(layer.y + anim.dy)} - 50%)) scale(${layer.scale * anim.scale})`,
              transformOrigin: 'center',
              opacity: anim.opacity < 1 ? anim.opacity : undefined,
              fontSize: cqw(content.fontSizePx),
              fontFamily: fontCssFamily(content.fontFamily),
              fontWeight: 'normal',
              width: content.widthPx != null ? cqw(content.widthPx) : undefined,
              maxWidth: content.widthPx != null ? undefined : '92%',
              zIndex: z
            }}
            className={`cursor-move select-none whitespace-pre-wrap text-center leading-tight ${
              selected ? 'outline-dashed outline-2 outline-sky-400' : ''
            }`}
          >
            <StyledText s={content} text={content.text} reveal={anim.revealChars} litWords={anim.litWords} />
          </div>
        )
      })}

      {/* Edge/corner resize handles on the selected layer (corners scale
          uniformly, edges stretch media / re-wrap text). */}
      {selectedLayer && handleBox && (
        <ResizeHandles
          box={handleBox}
          handles={
            selectedLayer.content.kind === 'text'
              ? TEXT_HANDLES
              : selectedLayer.content.kind === 'layout'
                ? CORNER_HANDLES
                : MEDIA_HANDLES
          }
          onStart={(e, handle) => startLayerResize(e, withKeyframedTransform(selectedLayer, time), handle)}
        />
      )}

      {!hasContent && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
          Add a clip to the timeline to begin
        </div>
      )}

      {/* Active captions: each rendered at its own effective style (lane-wide or
          per-caption override), positioned by center, draggable to reposition. */}
      {captions &&
        activeCaptions.map((seg) => {
          const st = effectiveCaptionStyle(captions, seg)
          const selected = seg.id === selectedCaptionId
          return (
            <div
              key={seg.id}
              onPointerDown={(e) => startCaptionMove(e, seg)}
              style={{
                position: 'absolute',
                left: pct(st.x, LOGICAL.width),
                top: pct(st.y, LOGICAL.height),
                transform: `translate(-50%, -50%) rotate(${st.rotationDeg}deg)`,
                transformOrigin: 'center',
                fontSize: cqw(st.fontSizePx),
                fontFamily: fontCssFamily(st.fontFamily),
                fontWeight: 'normal',
                maxWidth: '88%',
                zIndex: 300
              }}
              className={`cursor-move select-none whitespace-pre-wrap text-center leading-tight ${
                selected ? 'outline-dashed outline-2 outline-emerald-400' : ''
              }`}
            >
              <StyledText s={st} text={seg.text} />
            </div>
          )
        })}

      {/* Hook zone (first 3 seconds) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[400] flex h-[6%] items-center justify-center border-b border-amber-400/30 bg-amber-400/10 text-[10px] uppercase tracking-wide text-amber-300/80">
        Hook zone · first 3s
      </div>
      {/* Bottom safe zone */}
      <div
        className="pointer-events-none absolute left-0 z-[400] w-full border-t border-rose-400/40 bg-rose-500/10"
        style={{ top: pct(SAFE_ZONES.bottom.y, LOGICAL.height), height: pct(SAFE_ZONES.bottom.h, LOGICAL.height) }}
      />
      {/* Right action rail */}
      <div
        className="pointer-events-none absolute top-0 z-[400] h-full border-l border-rose-400/40 bg-rose-500/10"
        style={{ left: pct(SAFE_ZONES.rightRail.x, LOGICAL.width), width: pct(SAFE_ZONES.rightRail.w, LOGICAL.width) }}
      />
      <div className="pointer-events-none absolute left-2 top-2 z-[400] text-[10px] uppercase tracking-wide text-zinc-500">
        {LOGICAL.width} × {LOGICAL.height}
      </div>
    </div>
  )
}
