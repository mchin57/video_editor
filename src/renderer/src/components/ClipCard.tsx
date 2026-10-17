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
import { audioUrl, imageUrl, proxyUrl, thumbUrl } from '@/ipc/client'
import { useHoverGuard, useHoverIntent } from '@/hooks/useHoverIntent'
import { headerBottom, popoutPlacement } from '@/lib/popoutPlacement'
import { DescriptionBox } from './DescriptionBox'

/** Width of the description panel beside the preview pop-out. */
const DESC_W = 220
/** Height of an audio clip's pop-out, which is its description alone. */
const AUDIO_POPOUT_H = 170

/** What a pop-out shows beside the description: the playing video, the
 *  picture, or nothing (audio). */
type PopoutMedia = 'video' | 'image' | 'none'

/**
 * The video pane of a pop-out: plays the proxy with sound, looping, with a
 * click/drag scrub bar. The loop pauses while scrubbing and resumes on
 * release; a release outside the hover group closes it (`onScrubEnd`) — the
 * drag swallowed the mouseleave the group would have seen.
 */
function VideoPane({
  asset,
  width,
  onScrubEnd
}: {
  asset: MediaAsset
  width: number
  onScrubEnd: (at: Element | null) => void
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
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
        onScrubEnd(document.elementFromPoint(ev.clientX, ev.clientY))
      }
    )
  }

  const frac = dur > 0 ? Math.min(1, cur / dur) : 0
  return (
    <div data-testid="preview-popout" className="relative h-full shrink-0 bg-black" style={{ width }}>
      <video
        ref={ref}
        src={proxyUrl(asset)}
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
  )
}

/**
 * A library clip's hover pop-out, portaled to <body> so the timeline/library
 * overflow can't clip it: the media (`VideoPane` for a video, the picture for
 * an image, nothing for audio) with the clip's description beside it, on the
 * far side from the card, as an editable box (`DescriptionBox`). Anchored
 * beside the hovered thumbnail (flips to the other side near the viewport
 * edge), sized to the clip's aspect.
 *
 * Interactive: the thumbnail + popout form one hover group (`HoverIntent`), so
 * the cursor can travel onto the popout to scrub or type a description without
 * dismissing it. An invisible "bridge" spans the gap between card and popout
 * so the crossing never reads as a leave at all; a focused description pins
 * the group open (`onPin`).
 */
function HoverPopout({
  asset,
  anchor,
  media,
  onEnter,
  onLeave,
  onPin
}: {
  asset: MediaAsset
  anchor: HTMLElement
  media: PopoutMedia
  onEnter: () => void
  onLeave: () => void
  /** The description's focus; `hovered` = the cursor is over the card or popout right now. */
  onPin: (pinned: boolean, hovered: boolean) => void
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<HTMLDivElement>(null)
  // The pop-out sits beside the whole card, which joins the hover group so the
  // cursor can cross the card's name and buttons on its way to the pop-out.
  const card = anchor.closest('[data-clip-card]') ?? anchor
  useHoverGuard({ enter: onEnter, leave: onLeave }, () => [anchor, card, rootRef.current, bridgeRef.current])

  // An image's pane follows the decoded picture once it loads: the probe's size
  // ignores a JPEG's EXIF orientation (TODO.md ▸ Bugs ▸ "EXIF orientation").
  const [loadedAspect, setLoadedAspect] = useState<number | null>(null)
  const v = asset.probe.video
  const probed = v && v.displayWidth > 0 && v.displayHeight > 0 ? v.displayWidth / v.displayHeight : 9 / 16
  const aspect = media === 'image' && loadedAspect ? loadedAspect : probed
  const minTop = headerBottom() + 8
  const maxH = Math.min(560, window.innerHeight - minTop - 8)
  let width = 0
  let height = AUDIO_POPOUT_H
  if (media !== 'none') {
    width = 300
    height = Math.round(width / aspect)
    if (height > maxH) {
      height = maxH
      width = Math.round(height * aspect)
    }
  }
  const total = width + DESC_W
  // Beside the card (flipped near the viewport edge; the description stays on
  // the far side), below the header, with an invisible bridge over the gap.
  const { left, top, onRight, bridge } = popoutPlacement({
    card: card.getBoundingClientRect(),
    thumb: anchor.getBoundingClientRect(),
    width: total,
    height,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    minTop
  })

  const divider = media === 'none' ? '' : onRight ? 'border-l border-white/10' : 'border-r border-white/10'
  return createPortal(
    <>
      {bridge.width > 0 && (
        <div
          ref={bridgeRef}
          style={{ position: 'fixed', ...bridge }}
          className="z-[499]"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        />
      )}
      <div
        ref={rootRef}
        style={{ position: 'fixed', left, top, width: total, height }}
        className={`z-[500] flex overflow-hidden rounded-xl border border-white/15 bg-zinc-900 shadow-2xl ${
          onRight ? '' : 'flex-row-reverse'
        }`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        // Portaled, but React events still bubble to the thumbnail: a click here
        // must not toggle an audio card's playback.
        onClick={(e) => e.stopPropagation()}
      >
        {media === 'video' && (
          <VideoPane
            asset={asset}
            width={width}
            onScrubEnd={(at) => {
              if (!at || !rootRef.current?.contains(at)) onLeave()
            }}
          />
        )}
        {media === 'image' && (
          <div data-testid="preview-image" className="h-full shrink-0 bg-black" style={{ width }}>
            <img
              src={imageUrl(asset)}
              alt=""
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (w > 0 && h > 0) setLoadedAspect(w / h)
              }}
              className="h-full w-full object-contain"
            />
          </div>
        )}
        <div data-testid="library-description" className={`flex min-w-0 flex-1 flex-col gap-1.5 p-2 ${divider}`}>
          <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-zinc-400" title={asset.fileName}>
            Description
          </div>
          <DescriptionBox
            asset={asset}
            className="flex-1"
            onFocusChange={(on) => onPin(on, !!rootRef.current?.matches(':hover') || anchor.matches(':hover'))}
          />
        </div>
      </div>
    </>,
    document.body
  )
}

/**
 * First-frame thumbnail with a ▶ fallback until/if the jpg is available.
 * Hovering pops out a large preview beside the card — a video plays (with
 * sound), an image shows whole — with the clip's description beside it, so a
 * clip can be reviewed and described without placing it on the timeline. The
 * popout is interactive (scrub bar, description), so dismissal is a shared
 * hover group with a short close delay: it stays while the cursor is over the
 * card OR the popout, and a leave only closes it after a grace period a
 * re-enter cancels (no card→popout flicker).
 */
export function ClipThumb({ asset }: { asset: MediaAsset }): JSX.Element {
  // The ▶ fallback is tied to the asset data the thumb failed FOR: each library
  // refresh brings a new object, so the card tries again then. A card drawn a
  // moment before its thumb existed (cached list on reopen, a project just
  // converted) used to stay on ▶ for good though the thumb was right there.
  const [failedFor, setFailedFor] = useState<MediaAsset | null>(null)
  const failed = failedFor === asset
  const { target: hover, intent } = useHoverIntent<true>()
  const wrapRef = useRef<HTMLDivElement>(null)
  // An image's "proxy" is its display PNG; a video's, the playable proxy.
  const canPreview = asset.proxyReady && !!asset.probe.video
  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onMouseEnter={() => canPreview && intent.enter(true)}
      onMouseLeave={() => intent.leave()}
    >
      {failed ? (
        <span className="flex h-full w-full items-center justify-center text-base text-zinc-600">▶</span>
      ) : (
        <img
          src={thumbUrl(asset)}
          alt=""
          onError={() => setFailedFor(asset)}
          className="h-full w-full object-cover"
        />
      )}
      {hover && canPreview && wrapRef.current && (
        <HoverPopout
          asset={asset}
          anchor={wrapRef.current}
          media={isImageAsset(asset) ? 'image' : 'video'}
          onEnter={() => intent.enter()}
          onLeave={() => intent.leave()}
          onPin={(on, hovered) => intent.pin(on, hovered)}
        />
      )}
    </div>
  )
}

/** Audio card glyph: click to play/pause the proxy inline (▶/⏸ on hover).
 *  Hovering also pops out the clip's description beside the card. */
export function AudioThumb({ asset }: { asset: MediaAsset }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [playing, setPlaying] = useState(false)
  const [hover, setHover] = useState(false)
  const { target: popout, intent } = useHoverIntent<true>()
  const glyph = !asset.proxyReady ? '♪' : playing ? '⏸' : hover ? '▶' : '♪'
  return (
    <span
      ref={wrapRef}
      role="button"
      tabIndex={-1}
      onMouseEnter={() => {
        setHover(true)
        intent.enter(true)
      }}
      onMouseLeave={() => {
        setHover(false)
        intent.leave()
      }}
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
        src={audioUrl(asset)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {popout && wrapRef.current && (
        <HoverPopout
          asset={asset}
          anchor={wrapRef.current}
          media="none"
          onEnter={() => intent.enter()}
          onLeave={() => intent.leave()}
          onPin={(on, hovered) => intent.pin(on, hovered)}
        />
      )}
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
  onContextMenu,
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
  /** Right-click (the Library's menu: Rename…, Reveal in Explorer). */
  onContextMenu?: (e: React.MouseEvent) => void
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
      data-clip-card
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? -1 : undefined}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
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
