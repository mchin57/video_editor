import { create } from 'zustand'

/** High-frequency playback state, kept out of the project store (no undo churn). */
interface PlaybackState {
  playing: boolean
  /** Playhead position in timeline seconds. */
  time: number
  setPlaying: (v: boolean) => void
  setTime: (t: number) => void
  toggle: () => void
}

export const usePlayback = create<PlaybackState>((set) => ({
  playing: false,
  time: 0,
  setPlaying: (v) => set({ playing: v }),
  setTime: (t) => set({ time: Math.max(0, t) }),
  toggle: () => set((s) => ({ playing: !s.playing }))
}))
