/** Small display helpers for media metadata. */

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = (total % 60).toString().padStart(2, '0')
  // A recording an hour or longer (a workout file) reads `h:mm:ss`, not `120:14`.
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${Math.floor(total / 60)}:${s}`
}

/** `m:ss.cc` — a position to the hundredth, for trim/split readouts. */
export function formatClock(sec: number): string {
  const cs = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 100))
  const m = Math.floor(cs / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${m}:${s.toString().padStart(2, '0')}.${(cs % 100).toString().padStart(2, '0')}`
}

export function formatFps(fps: number): string {
  if (!fps) return '—'
  return `${Math.round(fps * 100) / 100} fps`
}

export function formatResolution(w: number, h: number): string {
  return `${w}×${h}`
}
