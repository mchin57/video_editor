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
 * The 9:16 playback surface. Plays the timeline (a single track of clips)
 * through one shared <video>, switching the proxy source at clip boundaries.
 * When the timeline is empty it falls back to previewing the library selection,
 * so a freshly imported clip is still watchable before it's added.
 */
export function PreviewStage(): JSX.Element {
  const project = useProject((s) => s.project)
  const projectClips = project?.clips ?? EMPTY_CLIPS
  const selectedLibId = useEditor((s) => s.selectedId)
  const { data: assets = [] } = useLibrary()
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const time = usePlayback((s) => s.time)
  const playing = usePlayback((s) => s.playing)
  const setTime = usePlayback((s) => s.setTime)
  const setPlaying = usePlayback((s) => s.setPlaying)

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
  const ready = Boolean(activeAsset?.proxyReady)

  const videoRef = useRef<HTMLVideoElement>(null)
  const loadedIdRef = useRef<string | null>(null)

  // Load the active proxy on media change; reseek while paused/scrubbing.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !activeAsset?.proxyReady || !pos) return undefined
    if (loadedIdRef.current !== activeAsset.id) {
      loadedIdRef.current = activeAsset.id
      v.src = proxyUrl(activeAsset.id)
      v.load()
      const seekTo = pos.sourceTime
      const onMeta = (): void => {
        v.currentTime = seekTo
        if (usePlayback.getState().playing) void v.play()
      }
      v.addEventListener('loadedmetadata', onMeta, { once: true })
      return () => v.removeEventListener('loadedmetadata', onMeta)
    }
    if (!playing && Math.abs(v.currentTime - pos.sourceTime) > 0.08) {
      v.currentTime = pos.sourceTime
    }
    return undefined
  }, [activeAsset?.id, activeAsset?.proxyReady, pos?.sourceTime, playing])

  // Start/stop. The seek effect already parks the <video> at the playhead while
  // paused, so resume-from-playhead works without gating play. We only special-
  // case "parked at the end" → restart from 0. play() is always attempted.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (!(playing && ready)) {
      v.pause()
      return
    }
    const total = timelineDuration(previewClips)
    if (usePlayback.getState().time >= total - 0.05) {
      setTime(0)
      const first = locate(previewClips, 0)
      if (first && loadedIdRef.current === first.clip.mediaId) v.currentTime = first.sourceTime
    }
    void v.play().catch(() => {})
  }, [playing, ready, previewClips, setTime])

  useEffect(() => {
    const v = videoRef.current
    if (v && activeClip) v.muted = activeClip.mute
  }, [activeClip])

  // During playback the video is the clock and drives clip advancement.
  useEffect(() => {
    if (!playing) return undefined
    let raf = 0
    const tick = (): void => {
      const v = videoRef.current
      if (v && pos && activeClip) {
        if (v.currentTime >= activeClip.outSec - 0.03) {
          const nextIndex = pos.index + 1
          if (nextIndex < previewClips.length) {
            const next = previewClips[nextIndex]
            setTime(starts[nextIndex] ?? 0)
            if (next.mediaId === activeClip.mediaId) v.currentTime = next.inSec
          } else {
            setPlaying(false)
            setTime(timelineDuration(previewClips))
            return
          }
        } else {
          setTime((starts[pos.index] ?? 0) + Math.max(0, v.currentTime - activeClip.inSec))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, pos?.index, activeClip, previewClips, starts, setTime, setPlaying])

  const hasContent = previewClips.length > 0

  return (
    <div className="relative aspect-[9/16] h-full overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10">
      <video
        ref={videoRef}
        playsInline
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
