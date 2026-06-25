import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { AudioClip, Layer, VideoContent } from '@shared/project'
import { audioClipEnd, effectiveOut } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { isFrozenAt, layersAtTime, makeVideoLayer, videoSourceTime, visualDuration } from '@shared/layers'
import { LOGICAL, SAFE_ZONES } from '@/lib/coords'
import { audioUrl, imageUrl, proxyUrl, thumbUrl } from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'

const pct = (value: number, total: number): string => `${(value / total) * 100}%`
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))
const FRAME_ASPECT = LOGICAL.width / LOGICAL.height

const EMPTY_LAYERS: Layer[] = []
const EMPTY_AUDIO: AudioClip[] = []

/** Absolute box (in %) for a media layer, sized to its aspect at the layer's
 *  scale and centered on (x,y). Aspect-correct so there's no letterbox fill to
 *  occlude the layers behind it; anything past the frame is cropped by the stage. */
function mediaBox(layer: Layer, aspect: number): CSSProperties {
  let w: number
  let h: number
  if (aspect >= FRAME_ASPECT) {
    w = LOGICAL.width
    h = LOGICAL.width / aspect
  } else {
    h = LOGICAL.height
    w = LOGICAL.height * aspect
  }
  w *= layer.scale
  h *= layer.scale
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
      className={`overflow-hidden ${selected ? 'cursor-move outline-dashed outline-2 outline-sky-400' : 'cursor-pointer'}`}
    >
      <video
        ref={ref}
        src={proxyUrl(asset.id)}
        muted={content.mute}
        playsInline
        style={fill}
        onLoadedMetadata={() => {
          const v = ref.current
          if (v) {
            v.currentTime = target
            v.muted = content.mute
          }
        }}
      />
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
    const before = useProject.getState().project
    if (!stage || !before) return
    const scale = LOGICAL.width / stage.getBoundingClientRect().width
    const startX = e.clientX
    const startY = e.clientY
    const onMove = (ev: PointerEvent): void => {
      const nx = layer.x + (ev.clientX - startX) * scale
      const ny = layer.y + (ev.clientY - startY) * scale
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => (l.id === layer.id ? { ...l, x: nx, y: ny } : l))
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

  // Drag the corner handle to zoom the selected layer.
  const startLayerZoom = (e: ReactPointerEvent, layer: Layer): void => {
    e.stopPropagation()
    e.preventDefault()
    const before = useProject.getState().project
    if (!before) return
    const startX = e.clientX
    const s0 = layer.scale
    const onMove = (ev: PointerEvent): void => {
      const ns = clamp(s0 + (ev.clientX - startX) * 0.004, 0.05, 8)
      useProject.getState().liveUpdate((p) => ({
        ...p,
        layers: p.layers.map((l) => (l.id === layer.id ? { ...l, scale: ns } : l))
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

  const activeLayers = layersAtTime(previewLayers, time).filter((l) => !l.hidden)
  const selectedLayer = activeLayers.find((l) => l.id === selectedLayerId) ?? null
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
      className="relative aspect-[9/16] h-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
    >
      {/* Audio track: one follower <audio> per clip (the browser mixes them) */}
      {audioClips.map((a) => {
        const asset = assetById.get(a.mediaId)
        if (!asset?.proxyReady) return null
        const src = asset.probe.video ? proxyUrl(asset.id) : audioUrl(asset.id)
        return <AudioFollower key={a.id} clip={a} asset={asset} src={src} time={time} playing={playing} />
      })}

      {/* The composited layer stack, back (index 0) → front. */}
      {activeLayers.map((layer, i) => {
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
          const cropped = cr && cr.h > 0 ? base * (cr.w / cr.h) : base
          const q = (((content.rotateQuarters ?? 0) % 4) + 4) % 4
          const odd = q === 1 || q === 3
          const box = { ...mediaBox(layer, odd ? 1 / cropped : cropped), zIndex: z, containerType: 'size' as const }
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

        // Text layer
        const content = layer.content
        return (
          <div
            key={layer.id}
            onPointerDown={onMoveDown}
            style={{
              position: 'absolute',
              left: pct(layer.x, LOGICAL.width),
              top: pct(layer.y, LOGICAL.height),
              transform: `translate(-50%, -50%) scale(${layer.scale})`,
              transformOrigin: 'center',
              fontSize: `${(content.fontSizePx / LOGICAL.width) * 100}cqw`,
              color: content.color,
              fontFamily: content.fontFamily,
              maxWidth: '92%',
              zIndex: z
            }}
            className={`cursor-move select-none whitespace-pre-wrap text-center font-extrabold leading-tight ${
              selected ? 'outline-dashed outline-2 outline-sky-400' : ''
            }`}
          >
            <span
              style={
                content.pill.enabled
                  ? {
                      background: content.pill.color,
                      padding: `${(content.pill.padPx / LOGICAL.width) * 100}cqw`,
                      borderRadius: `${(10 / LOGICAL.width) * 100}cqw`,
                      boxDecorationBreak: 'clone',
                      WebkitBoxDecorationBreak: 'clone'
                    }
                  : { textShadow: '0 0.2cqw 0.8cqw rgba(0,0,0,0.85)' }
              }
            >
              {content.text}
            </span>
          </div>
        )
      })}

      {/* Zoom handle for the selected layer (pinned to the stage corner so it's
          always reachable regardless of where the layer sits). */}
      {selectedLayer && (
        <span
          onPointerDown={(e) => startLayerZoom(e, selectedLayer)}
          title="Drag to zoom the selected layer"
          className="absolute bottom-2 right-2 z-[200] flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded border border-white/70 bg-sky-500 text-[11px] text-white shadow"
        >
          ⤢
        </span>
      )}

      {!hasContent && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
          Add a clip to the timeline to begin
        </div>
      )}

      {/* Active captions (auto-generated), stacked upward from the baseline so
          overlapping audio clips each show their own caption. */}
      {activeCaptions.length > 0 && captions && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: pct(LOGICAL.height - captions.yBaseline, LOGICAL.height),
            transform: 'translateX(-50%)',
            width: '88%',
            zIndex: 300
          }}
          className="flex flex-col items-center gap-[1cqw]"
        >
          {activeCaptions.map((s) => (
            <div
              key={s.id}
              style={{
                fontSize: `${(64 / LOGICAL.width) * 100}cqw`,
                color: '#ffffff',
                textShadow: '0 0.25cqw 0.6cqw rgba(0,0,0,0.95), 0 0 0.3cqw rgba(0,0,0,0.95)'
              }}
              className="text-center font-extrabold leading-tight"
            >
              {s.text}
            </div>
          ))}
        </div>
      )}

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
