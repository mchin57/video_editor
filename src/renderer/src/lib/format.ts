/** Small display helpers for media metadata. */

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const total = Math.round(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatFps(fps: number): string {
  if (!fps) return '—'
  return `${Math.round(fps * 100) / 100} fps`
}

export function formatResolution(w: number, h: number): string {
  return `${w}×${h}`
}
