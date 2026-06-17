import { useEffect, useMemo, useRef, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioClip, Clip, TextOverlay } from '@shared/project'
import { audioClipEnd, effectiveOut } from '@shared/project'
import type { MediaAsset } from '@shared/media'
import { LOGICAL, SAFE_ZONES } from '@/lib/coords'
import { overlaysAtTime } from '@/lib/overlays'
import { audioUrl, proxyUrl, thumbUrl } from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import { clipStartTimes, locate, timelineDuration } from '@/lib/timeline'

const pct = (value: number, total: number): string => `${(value / total) * 100}%`
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi))

// Stable empty references so zustand selectors don't return new arrays each render.
const EMPTY_CLIPS: Clip[] = []
const EMPTY_OVERLAYS: TextOverlay[] = []
const EMPTY_AUDIO: AudioClip[] = []

/** A hidden <audio> that follows the timeline clock for one audio clip. Several
 * of these play at once; the browser mixes them (no Web Audio needed). */
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

/**
 * The 9:16 playback surface. Plays the timeline through a single <video> keyed
 * by the active media id; applies the active clip's crop with CSS; and renders
 * draggable text overlays positioned in the logical 1080x1920 space (cqw units
 * keep them sized exactly as they'll burn at export).
 */
export function PreviewStage(): JSX.Element {
  const project = useProject((s) => s.project)
  const projectClips = project?.clips ?? EMPTY_CLIPS
  const overlays = project?.overlays ?? EMPTY_OVERLAYS
  const selectedLibId = useEditor((s) => s.selectedId)
  const selectedOverlayId = useUi((s) => s.selectedOverlayId)
  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)

  const selectedAsset = selectedLibId ? assetById.get(selectedLibId) : undefined
  const previewClips: Clip[] = useMemo(() => {
    if (projectClips.length) return projectClips
    if (selectedAsset) {
      return [
        {
          id: '__preview__',
          mediaId: selectedAsset.id,
          inSec: 0,
          outSec: selectedAsset.probe.durationSec,
          crop: null,
          mute: false,
          gainDb: 0
        }
      ]
    }
    return []
  }, [projectClips, selectedAsset])

  const starts = useMemo(() => clipStartTimes(previewClips), [previewClips])
  const pos = locate(previewClips, time)
  const activeClip = pos?.clip ?? null
  const activeAsset = activeClip ? assetById.get(activeClip.mediaId) : undefined
  const activeMediaId = activeAsset?.proxyReady ? activeAsset.id : null
  const ready = activeMediaId != null

  // Audio track: end of the furthest audio clip, and the overall project end.
  const audioClips = project?.audioClips ?? EMPTY_AUDIO
  const audioEnd = useMemo(
    () =>
      audioClips.reduce(
        (max, a) => Math.max(max, audioClipEnd(a, assetById.get(a.mediaId)?.probe.durationSec ?? a.outSec)),
        0
      ),
    [audioClips, assetById]
  )
  const audioEndRef = useRef(audioEnd)
  audioEndRef.current = audioEnd

  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Live refs so the rAF loop reads current values without re-subscribing.
  const clipsRef = useRef(previewClips)
  clipsRef.current = previewClips
  const startsRef = useRef(starts)
  startsRef.current = starts
  const posRef = useRef(pos)
  posRef.current = pos

  const onLoadedMetadata = (): void => {
    const v = videoRef.current
    const p = posRef.current
    if (!v || !p) return
    v.currentTime = p.sourceTime
    v.muted = p.clip.mute
    if (usePlayback.getState().playing) void v.play().catch(() => {})
  }

  // Paused/scrubbing: keep the video parked at the playhead.
  useEffect(() => {
    if (playing) return
    const v = videoRef.current
    if (v && pos && v.readyState >= 1 && Math.abs(v.currentTime - pos.sourceTime) > 0.06) {
      v.currentTime = pos.sourceTime
    }
  }, [playing, pos?.sourceTime])

  // Play/pause (restart from 0 if parked at the very end of the project).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (!(playing && ready)) {
      v.pause()
      return
    }
    const projEnd = Math.max(timelineDuration(clipsRef.current), audioEndRef.current)
    if (usePlayback.getState().time >= projEnd - 0.05) {
      usePlayback.getState().setTime(0)
      const first = locate(clipsRef.current, 0)
      if (first && first.clip.mediaId === activeMediaId) v.currentTime = first.sourceTime
    }
    void v.play().catch(() => {})
  }, [playing, ready, activeMediaId])

  // The clock. The video drives time while it's the active source; past the last
  // clip (audio-only tail) a wall clock takes over so audio keeps playing.
  useEffect(() => {
    if (!playing) return undefined
    let raf = 0
    let lastNow = performance.now()
    const tick = (): void => {
      if (!usePlayback.getState().playing) return
      const v = videoRef.current
      const clips = clipsRef.current
      const startsNow = startsRef.current
      const { setTime, setPlaying } = usePlayback.getState()
      const t = usePlayback.getState().time
      const videoTotal = timelineDuration(clips)
      const projTotal = Math.max(videoTotal, audioEndRef.current)
      const inVideo = clips.length > 0 && t < videoTotal - 0.001

      if (inVideo) {
        if (v && ready && v.paused) void v.play().catch(() => {})
        if (v && v.readyState >= 2) {
          const p = locate(clips, t)
          if (p) {
            if (v.currentTime >= p.clip.outSec - 0.04) {
              const nextIdx = p.index + 1
              if (nextIdx < clips.length) {
                const next = clips[nextIdx]
                setTime(startsNow[nextIdx] ?? 0)
                if (next.mediaId === p.clip.mediaId && Math.abs(v.currentTime - next.inSec) > 0.05) {
                  v.currentTime = next.inSec
                }
              } else if (videoTotal < projTotal) {
                setTime(videoTotal) // fall through to the audio-only tail
              } else {
                setPlaying(false)
                setTime(projTotal)
                return
              }
            } else {
              setTime((startsNow[p.index] ?? 0) + Math.max(0, v.currentTime - p.clip.inSec))
            }
          }
        }
        lastNow = performance.now()
      } else {
        if (v && !v.paused) v.pause() // freeze the last frame while audio plays on
        const now = performance.now()
        const dt = (now - lastNow) / 1000
        lastNow = now
        const nt = t + dt
        if (nt >= projTotal - 0.001) {
          setPlaying(false)
          setTime(projTotal)
          return
        }
        setTime(nt)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, ready])

  useEffect(() => {
    const v = videoRef.current
    if (v && activeClip) v.muted = activeClip.mute
  }, [activeClip])

  // Crop: map the active clip's source-pixel crop into the 9:16 stage with CSS.
  const videoStyle: CSSProperties = useMemo(() => {
    const crop = activeClip?.crop
    const v = activeAsset?.probe.video
    const col = activeClip?.color
    // Mirror the export eq() filter so preview color matches output.
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
        background: 'black',
        filter
      }
    }
    return { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'black', filter }
  }, [activeClip?.crop, activeClip?.color, activeAsset?.probe.video])

  const startOverlayDrag = (e: ReactPointerEvent, o: TextOverlay): void => {
    e.stopPropagation()
    e.preventDefault()
    useUi.getState().selectOverlay(o.id)
    const stage = stageRef.current
    const before = useProject.getState().project
    if (!stage || !before) return
    const scale = LOGICAL.width / stage.getBoundingClientRect().width // logical px per screen px
    const startX = e.clientX
    const startY = e.clientY
    const onMove = (ev: PointerEvent): void => {
      const nx = clamp(o.x + (ev.clientX - startX) * scale, 0, LOGICAL.width)
      const ny = clamp(o.y + (ev.clientY - startY) * scale, 0, LOGICAL.height)
      useProject.getState().liveUpdate((p) => ({
        ...p,
        overlays: p.overlays.map((x) => (x.id === o.id ? { ...x, x: nx, y: ny } : x))
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

  const visibleOverlays = overlaysAtTime(overlays, time)
  const captions = project?.captions
  const activeCaption = captions?.enabled
    ? captions.segments.find((s) => s.enabled && time >= s.startSec && time < s.endSec)
    : undefined
  const hasContent = previewClips.length > 0

  return (
    <div
      ref={stageRef}
      style={{ containerType: 'size' }}
      className="relative aspect-[9/16] h-full overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10"
    >
      <video
        key={activeMediaId ?? 'empty'}
        ref={videoRef}
        src={activeMediaId ? proxyUrl(activeMediaId) : undefined}
        playsInline
        style={videoStyle}
        onLoadedMetadata={onLoadedMetadata}
        onClick={() => usePlayback.getState().toggle()}
        className={ready ? '' : 'opacity-0'}
      />

      {/* Audio track: one follower <audio> per clip (the browser mixes them) */}
      {audioClips.map((a) => {
        const asset = assetById.get(a.mediaId)
        if (!asset?.proxyReady) return null
        const src = asset.probe.video ? proxyUrl(asset.id) : audioUrl(asset.id)
        return <AudioFollower key={a.id} clip={a} asset={asset} src={src} time={time} playing={playing} />
      })}


      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-600">
          {hasContent && activeAsset ? (
            <>
              <img
                src={thumbUrl(activeAsset.id)}
                alt=""
                onError={(e) => (e.currentTarget.style.display = 'none')}
                className="absolute inset-0 h-full w-full object-contain opacity-40"
              />
              <span className="z-10">Generating preview…</span>
            </>
          ) : (
            'Add a clip to the timeline to begin'
          )}
        </div>
      )}

      {/* Text overlays (only those visible at the current time) */}
      {visibleOverlays.map((o) => (
        <div
          key={o.id}
          onPointerDown={(e) => startOverlayDrag(e, o)}
          style={{
            position: 'absolute',
            left: pct(o.x, LOGICAL.width),
            top: pct(o.y, LOGICAL.height),
            transform: o.anchor === 'center' ? 'translate(-50%, -50%)' : 'none',
            fontSize: `${(o.fontSizePx / LOGICAL.width) * 100}cqw`,
            color: o.color,
            maxWidth: '92%'
          }}
          className={`z-30 cursor-move select-none whitespace-pre-wrap text-center font-extrabold leading-tight ${
            selectedOverlayId === o.id ? 'outline-dashed outline-2 outline-sky-400' : ''
          }`}
        >
          <span
            style={
              o.pill.enabled
                ? {
                    background: o.pill.color,
                    padding: `${(o.pill.padPx / LOGICAL.width) * 100}cqw`,
                    borderRadius: `${(10 / LOGICAL.width) * 100}cqw`,
                    boxDecorationBreak: 'clone',
                    WebkitBoxDecorationBreak: 'clone'
                  }
                : { textShadow: '0 0.2cqw 0.8cqw rgba(0,0,0,0.85)' }
            }
          >
            {o.text}
          </span>
        </div>
      ))}

      {/* Active caption (auto-generated), at the configured baseline */}
      {activeCaption && captions && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: pct(captions.yBaseline, LOGICAL.height),
            transform: 'translate(-50%, -50%)',
            fontSize: `${(64 / LOGICAL.width) * 100}cqw`,
            maxWidth: '88%',
            color: '#ffffff',
            textShadow: '0 0.25cqw 0.6cqw rgba(0,0,0,0.95), 0 0 0.3cqw rgba(0,0,0,0.95)'
          }}
          className="z-30 text-center font-extrabold leading-tight"
        >
          {activeCaption.text}
        </div>
      )}

      {/* Hook zone (first 3 seconds) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-[6%] items-center justify-center border-b border-amber-400/30 bg-amber-400/10 text-[10px] uppercase tracking-wide text-amber-300/80">
        Hook zone · first 3s
      </div>
      {/* Bottom safe zone */}
      <div
        className="pointer-events-none absolute left-0 z-40 w-full border-t border-rose-400/40 bg-rose-500/10"
        style={{ top: pct(SAFE_ZONES.bottom.y, LOGICAL.height), height: pct(SAFE_ZONES.bottom.h, LOGICAL.height) }}
      />
      {/* Right action rail */}
      <div
        className="pointer-events-none absolute top-0 z-40 h-full border-l border-rose-400/40 bg-rose-500/10"
        style={{ left: pct(SAFE_ZONES.rightRail.x, LOGICAL.width), width: pct(SAFE_ZONES.rightRail.w, LOGICAL.width) }}
      />
      <div className="pointer-events-none absolute left-2 top-2 z-40 text-[10px] uppercase tracking-wide text-zinc-500">
        {LOGICAL.width} × {LOGICAL.height}
      </div>
    </div>
  )
}
