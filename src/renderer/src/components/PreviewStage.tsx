import { useEffect, useMemo, useRef, type JSX } from 'react'
import type { Clip } from '@shared/project'
import { LOGICAL, SAFE_ZONES } from '@/lib/coords'
import { proxyUrl, thumbUrl } from '@/ipc/client'
import { useLibrary } from '@/hooks/useMedia'
import { useEditor } from '@/state/store'
import { useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { clipStartTimes, locate, timelineDuration } from '@/lib/timeline'

const pct = (value: number, total: number): string => `${(value / total) * 100}%`

// Stable empty reference so the zustand selector doesn't return a new array each
// render (which would make getSnapshot uncacheable → infinite re-render loop).
const EMPTY_CLIPS: Clip[] = []

/**
 * The 9:16 playback surface. Plays the timeline (one track of clips) through a
 * single <video> keyed by the active media id, so React swaps the proxy source
 * cleanly at clip boundaries. When the timeline is empty it previews the library
 * selection instead, so a freshly imported clip is still watchable.
 *
 * Clock model:
 *   - playing → the <video> is the clock; a rAF loop reads currentTime, advances
 *     the timeline `time`, and hops to the next clip at each out-point.
 *   - paused  → `time` is the clock; an effect seeks the <video> to the playhead.
 * The two never run at once, so there's no feedback fight.
 */
export function PreviewStage(): JSX.Element {
  const project = useProject((s) => s.project)
  const projectClips = project?.clips ?? EMPTY_CLIPS
  const selectedLibId = useEditor((s) => s.selectedId)
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

  const videoRef = useRef<HTMLVideoElement>(null)

  // Live refs so the rAF loop reads current values without re-subscribing.
  const clipsRef = useRef(previewClips)
  clipsRef.current = previewClips
  const startsRef = useRef(starts)
  startsRef.current = starts
  const posRef = useRef(pos)
  posRef.current = pos

  // On (re)mount of a media source, seek to the right spot and resume if playing.
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

  // Play/pause the element (restart from 0 if parked at the very end).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (!(playing && ready)) {
      v.pause()
      return
    }
    if (usePlayback.getState().time >= timelineDuration(clipsRef.current) - 0.05) {
      usePlayback.getState().setTime(0)
      const first = locate(clipsRef.current, 0)
      if (first && first.clip.mediaId === activeMediaId) v.currentTime = first.sourceTime
    }
    void v.play().catch(() => {})
  }, [playing, ready, activeMediaId])

  // The clock. Depends only on `playing`; reads everything else from refs so it
  // runs uninterrupted across clip boundaries.
  useEffect(() => {
    if (!playing) return undefined
    let raf = 0
    const tick = (): void => {
      const v = videoRef.current
      const clips = clipsRef.current
      const startsNow = startsRef.current
      const { setTime, setPlaying } = usePlayback.getState()
      // Skip until the (possibly just-swapped) source has a real currentTime.
      if (v && v.readyState >= 2 && clips.length) {
        const p = locate(clips, usePlayback.getState().time)
        if (p) {
          if (v.currentTime >= p.clip.outSec - 0.04) {
            const nextIdx = p.index + 1
            if (nextIdx < clips.length) {
              const next = clips[nextIdx]
              setTime(startsNow[nextIdx] ?? 0)
              if (next.mediaId === p.clip.mediaId && Math.abs(v.currentTime - next.inSec) > 0.05) {
                v.currentTime = next.inSec
              }
            } else {
              setPlaying(false)
              setTime(timelineDuration(clips))
              return
            }
          } else {
            setTime((startsNow[p.index] ?? 0) + Math.max(0, v.currentTime - p.clip.inSec))
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // Keep mute in sync when switching clips while paused.
  useEffect(() => {
    const v = videoRef.current
    if (v && activeClip) v.muted = activeClip.mute
  }, [activeClip])

  const hasContent = previewClips.length > 0

  return (
    <div className="relative aspect-[9/16] h-full overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10">
      <video
        key={activeMediaId ?? 'empty'}
        ref={videoRef}
        src={activeMediaId ? proxyUrl(activeMediaId) : undefined}
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onClick={() => usePlayback.getState().toggle()}
        className={`absolute inset-0 h-full w-full bg-black object-contain ${ready ? '' : 'opacity-0'}`}
      />

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

      {/* Hook zone (first 3 seconds) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[6%] items-center justify-center border-b border-amber-400/30 bg-amber-400/10 text-[10px] uppercase tracking-wide text-amber-300/80">
        Hook zone · first 3s
      </div>
      {/* Bottom safe zone */}
      <div
        className="pointer-events-none absolute left-0 w-full border-t border-rose-400/40 bg-rose-500/10"
        style={{ top: pct(SAFE_ZONES.bottom.y, LOGICAL.height), height: pct(SAFE_ZONES.bottom.h, LOGICAL.height) }}
      />
      {/* Right action rail */}
      <div
        className="pointer-events-none absolute top-0 h-full border-l border-rose-400/40 bg-rose-500/10"
        style={{ left: pct(SAFE_ZONES.rightRail.x, LOGICAL.width), width: pct(SAFE_ZONES.rightRail.w, LOGICAL.width) }}
      />
      <div className="pointer-events-none absolute left-2 top-2 text-[10px] uppercase tracking-wide text-zinc-500">
        {LOGICAL.width} × {LOGICAL.height}
      </div>
    </div>
  )
}
