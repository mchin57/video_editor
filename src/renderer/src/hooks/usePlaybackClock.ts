import { useEffect, useRef } from 'react'
import { usePlayback } from '@/state/playback'

/**
 * The preview's master clock: while playing, a wall clock advances the
 * playhead (`usePlayback.time`) every animation frame, so any number of video
 * layers can play at once — each follows the playhead on its own. Play from
 * the end starts over at 0; reaching the end stops there. `duration` is read
 * live, so an edit during playback moves the end without restarting the clock.
 */
export function usePlaybackClock(duration: number): void {
  const playing = usePlayback((s) => s.playing)
  const durationRef = useRef(duration)
  durationRef.current = duration

  useEffect(() => {
    if (!playing) return undefined
    const playback = usePlayback.getState
    if (playback().time >= durationRef.current - 0.05) playback().setTime(0)
    let raf = 0
    let last = performance.now()
    const tick = (): void => {
      if (!playback().playing) return
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      const nt = playback().time + dt
      if (nt >= durationRef.current - 0.001) {
        playback().setPlaying(false)
        playback().setTime(Math.max(0, durationRef.current))
        return
      }
      playback().setTime(nt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])
}
