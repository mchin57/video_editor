/**
 * Shared clip-card building blocks: the thumbnail (with the hover preview
 * screen), the audio glyph, the source badges, and the `ClipCard` SHELL that
 * lays them out beside a name/meta block and a trailing action slot.
 *
 * `ClipCard` is the common parent two callers render slightly differently:
 *  - the Library (`ClipRow`) — selectable + draggable, trailing = add / remove;
 *  - a layout cell (`FormatMenu`) — static, trailing = trim / mute / clear, and
 *    no "add to timeline" (the clip is already placed inside the layout).
 * Both get the same thumbnail + hover preview for free. @see docs/SHARED.md
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MediaAsset } from '@shared/media'
import { isImageAsset } from '@shared/media'
import { formatDuration } from '@/lib/format'
import { startPointerDrag } from '@/lib/pointerDrag'
import { audioUrl, proxyUrl, thumbUrl } from '@/ipc/client'

/**
 * Large floating video preview, portaled to <body> so the timeline/library
 * overflow can't clip it. Anchored beside the hovered card (flips to the other
 * side near the viewport edge), sized to the clip's aspect, and plays with sound.
 *
 * Interactive: the card + popout form one hover group (`onEnter`/`onLeave` feed
 * the card's delayed-close timer), so the cursor can travel onto the popout to
 * grab the scrub bar without dismissing it. An invisible "bridge" spans the gap
 * between card and popout so the crossing never reads as a leave at all.
 */
function PreviewPopout({
  asset,
  anchor,
  onEnter,
  onLeave
}: {
  asset: MediaAsset
  anchor: HTMLElement
  onEnter: () => void
  onLeave: () => void
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [dur, setDur] = useState(0)
  const [cur, setCur] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    el.volume = 1
    void el.play().catch(() => {})
    // Smooth progress (timeupdate alone is ~4 Hz).
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const v = ref.current
      if (v) setCur(v.currentTime)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const v = asset.probe.video
  const aspect = v && v.displayWidth > 0 && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 9 / 16
  const margin = 12
  const maxH = Math.min(560, window.innerHeight - 16)
  let width = 300
  let height = Math.round(width / aspect)
  if (height > maxH) {
    height = maxH
    width = Math.round(height * aspect)
  }
  const rect = anchor.getBoundingClientRect()
  let left = rect.right + margin
  if (left + width > window.innerWidth - 8) left = rect.left - margin - width // flip to the left
  left = Math.max(8, left)
  const top = Math.max(8, Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - 8))

  // Invisible strip covering the card→popout gap, tall enough to span both.
  const bridgeLeft = left >= rect.right ? rect.right : left + width
  const bridgeWidth = left >= rect.right ? left - rect.right : rect.left - (left + width)
  const bridgeTop = Math.min(top, rect.top)
  const bridgeHeight = Math.max(top + height, rect.bottom) - bridgeTop

  // Click/drag on the bar seeks; the loop pauses while scrubbing and resumes on
  // release. If the release lands outside the hover group, close (with the usual
  // grace delay) — the drag swallowed the mouseleave the group would have seen.
  const seekTo = (clientX: number): void => {
    const vid = ref.current
    const bar = barRef.current
    if (!vid || !bar || !Number.isFinite(vid.duration) || vid.duration <= 0) return
    const r = bar.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)))
    vid.currentTime = frac * vid.duration
    setCur(vid.currentTime)
  }
  const onBarDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    ref.current?.pause()
    seekTo(e.clientX)
    startPointerDrag(
      (ev) => seekTo(ev.clientX),
      (ev) => {
        void ref.current?.play().catch(() => {})
        const at = document.elementFromPoint(ev.clientX, ev.clientY)
        if (!at || !rootRef.current?.contains(at)) onLeave()
      }
    )
  }

  const frac = dur > 0 ? Math.min(1, cur / dur) : 0
  return createPortal(
    <>
      {bridgeWidth > 0 && (
        <div
          style={{ position: 'fixed', left: bridgeLeft, top: bridgeTop, width: bridgeWidth, height: bridgeHeight }}
          className="z-[499]"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        />
      )}
      <div
        ref={rootRef}
        data-testid="preview-popout"
        style={{ position: 'fixed', left, top, width, height }}
        className="z-[500] overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <video
          ref={ref}
          src={proxyUrl(asset.id)}
          loop
          autoPlay
          playsInline
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
          className="h-full w-full object-contain"
        />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5">
          <div className="mb-0.5 flex justify-between font-mono text-[9px] text-zinc-300">
            <span data-testid="popout-time">{formatDuration(cur)}</span>
            <span>{formatDuration(dur)}</span>
          </div>
          <div
            ref={barRef}
            data-testid="popout-scrub"
            onPointerDown={onBarDown}
            title="Click or drag to seek"
            className="relative h-3 cursor-pointer"
          >
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-white/25" />
            <div
              className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded bg-sky-400"
              style={{ width: `${frac * 100}%` }}
            />
            <div
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-300 shadow"
              style={{ left: `${frac * 100}%` }}
            />
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}

/**
 * First-frame thumbnail with a ▶ fallback until/if the jpg is available. Hovering
 * a video clip pops out a large preview beside the card (with sound), so a clip
 * can be reviewed without placing it on the timeline. The popout is interactive
 * (scrub bar), so dismissal is a shared hover group with a short close delay:
 * it stays while the cursor is over the card OR the popout, and a leave only
 * closes it after a grace period a re-enter cancels (no card→popout flicker).
 */
export function ClipThumb({ asset }: { asset: MediaAsset }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const [hover, setHover] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number | null>(null)
  const canPreview = asset.proxyReady && !!asset.probe.video && !isImageAsset(asset)
  const show = (): void => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
    setHover(true)
  }
  const scheduleHide = (): void => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setHover(false), 160)
  }
  useEffect(
    () => () => {
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current)
    },
    []
  )
  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onMouseEnter={() => canPreview && show()}
      onMouseLeave={scheduleHide}
    >
      {failed ? (
        <span className="flex h-full w-full items-center justify-center text-base text-zinc-600">▶</span>
      ) : (
        <img
          src={thumbUrl(asset.id)}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
      {hover && canPreview && wrapRef.current && (
        <PreviewPopout asset={asset} anchor={wrapRef.current} onEnter={show} onLeave={scheduleHide} />
      )}
    </div>
  )
}

/** Audio card glyph: click to play/pause the proxy inline (▶/⏸ on hover). */
export function AudioThumb({ asset }: { asset: MediaAsset }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [hover, setHover] = useState(false)
  const glyph = !asset.proxyReady ? '♪' : playing ? '⏸' : hover ? '▶' : '♪'
  return (
    <span
      role="button"
      tabIndex={-1}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation()
        const el = audioRef.current
        if (!asset.proxyReady || !el) return
        if (el.paused) void el.play()
        else el.pause()
      }}
      className="flex h-full w-full items-center justify-center text-base text-sky-300"
      title={asset.proxyReady ? (playing ? 'Pause preview' : 'Play preview') : undefined}
    >
      {glyph}
      <audio
        ref={audioRef}
        src={audioUrl(asset.id)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </span>
  )
}

export function ClipBadges({ asset }: { asset: MediaAsset }): JSX.Element | null {
  const v = asset.probe.video
  if (!v) return null
  return (
    <div className="flex flex-wrap gap-1">
      {v.isHdr && (
        <span className="rounded bg-fuchsia-500/15 px-1 text-[9px] font-medium text-fuchsia-300">HDR</span>
      )}
      {v.isVfr && (
        <span className="rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-300">VFR</span>
      )}
      {v.rotationDeg !== 0 && (
        <span className="rounded bg-sky-500/15 px-1 text-[9px] font-medium text-sky-300">⟳{v.rotationDeg}°</span>
      )}
    </div>
  )
}

/** The 9:16 thumbnail cell (audio glyph / video-with-hover / image), with the
 *  proxy-progress bar underneath while a video is still transcoding. */
function ThumbCell({ asset, proxyPct }: { asset: MediaAsset; proxyPct?: number }): JSX.Element {
  const isAudio = !asset.probe.video && !!asset.probe.audio
  return (
    <div className="relative flex h-16 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-black/60 text-zinc-600">
      {isAudio ? <AudioThumb asset={asset} /> : <ClipThumb asset={asset} />}
      {!asset.proxyReady && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-700">
          <div className="h-full bg-sky-400 transition-all" style={{ width: `${proxyPct ?? 0}%` }} />
        </div>
      )}
    </div>
  )
}

/**
 * The shared clip-card shell: thumbnail (+ hover preview) beside a name/meta
 * block, with an optional trailing action column and an optional footer under
 * the meta. Selection/drag are opt-in (the Library uses them; a layout cell
 * doesn't). Proxy state: badges once ready, else the "generating…"/"failed"
 * note driven by `proxyPct`/`proxyError`.
 */
export function ClipCard({
  asset,
  selected,
  onClick,
  draggable,
  onDragStart,
  trailing,
  footer,
  proxyPct,
  proxyError
}: {
  asset: MediaAsset
  selected?: boolean
  onClick?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  trailing?: ReactNode
  footer?: ReactNode
  proxyPct?: number
  proxyError?: boolean
}): JSX.Element {
  const v = asset.probe.video
  const isImage = isImageAsset(asset)
  const clickable = !!onClick
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? -1 : undefined}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      className={`group flex w-full gap-2 rounded-lg border p-2 text-left transition ${
        selected ? 'border-sky-400/50 bg-sky-400/10' : 'border-white/5 bg-white/[0.02] hover:bg-white/5'
      }`}
    >
      <ThumbCell asset={asset} proxyPct={proxyPct} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-200" title={asset.fileName}>
          {asset.fileName}
        </div>
        <div className="mt-0.5 text-[10px] text-zinc-500">
          {v ? `${v.displayWidth}×${v.displayHeight}` : 'no video'} ·{' '}
          {isImage ? 'image' : formatDuration(asset.probe.durationSec)}
        </div>
        <div className="mt-1">
          {asset.proxyReady ? (
            <ClipBadges asset={asset} />
          ) : proxyError ? (
            <span className="text-[10px] text-rose-400">proxy failed</span>
          ) : (
            <span className="text-[10px] text-sky-400/80">generating preview… {proxyPct ?? 0}%</span>
          )}
        </div>
        {footer}
      </div>

      {trailing && <div className="flex w-12 shrink-0 flex-col items-stretch gap-1">{trailing}</div>}
    </div>
  )
}
