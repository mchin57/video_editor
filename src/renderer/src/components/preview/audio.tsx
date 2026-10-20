/** Preview ▸ audio: the elements that play a composition's audio clips in step with the playhead. */

import { useEffect, useRef, type JSX } from 'react'
import type { AudioClip } from '@shared/project'
import { effectiveOut } from '@shared/project'
import { type MediaAsset } from '@shared/media'
import { audioUrl, videoProxyUrl } from '@/ipc/client'
import { useMediaGain } from '@/lib/mediaGain'
import { useClipGain } from '@/hooks/useClipGain'

/** A hidden <audio> that follows the timeline clock for one audio clip. */
export function AudioFollower({
  clip,
  clips,
  asset,
  durationOf,
  src,
  time,
  playing
}: {
  clip: AudioClip
  /** The clip's composition — an effect track follows its source's level. */
  clips: AudioClip[]
  asset: MediaAsset
  durationOf: (mediaId: string) => number
  src: string
  time: number
  playing: boolean
}): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const eo = effectiveOut(clip, asset.probe.durationSec)
  const active = time >= clip.startSec - 0.001 && time < clip.startSec + (eo - clip.inSec)
  const target = clip.inSec + (time - clip.startSec)

  // The gain comes from `clipGain` (shared/volumeLevels.ts) — the export's own
  // call — so a clip in a volume level previews at the level's gain, not its
  // own slider. Element `volume` clamps at 1.0, so a boosted clip is routed
  // through a GainNode to match the export's `volume=` filter. @see
  // lib/mediaGain.ts. A muted clip is held at gain 0 rather than skipped, so it
  // keeps following the playhead and unmuting mid-playback is instant. The
  // export reaches the same silence by dropping the clip — `audible` is the
  // shared decision.
  const gain = useClipGain(clip, clips, durationOf)
  useMediaGain(ref, gain.gainDb, !gain.audible)

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
      data-clip-id={clip.id}
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
export function CompAudioTrack({
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
  const durationOf = (id: string): number => assetById.get(id)?.probe.durationSec ?? 0
  return (
    <>
      {clips.map((a) => {
        const asset = assetById.get(a.mediaId)
        if (!asset?.proxyReady) return null
        const src = asset.probe.video ? videoProxyUrl(asset) : audioUrl(asset)
        return (
          <AudioFollower
            key={a.id}
            clip={a}
            clips={clips}
            asset={asset}
            durationOf={durationOf}
            src={src}
            time={time}
            playing={playing}
          />
        )
      })}
    </>
  )
}
