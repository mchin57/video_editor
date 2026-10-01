/** Long-running background work (proxy generation, transcription, export). */

export type JobType = 'proxy' | 'transcribe' | 'export' | 'matte'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface Job {
  id: string
  type: JobType
  status: JobStatus
  /** 0..1 */
  progress: number
  /** Short human-readable phase, e.g. "Generating proxy", "Downloading model". */
  label: string
  /** Present when status === 'error'. */
  error?: string
  /** Optional payload identifying the subject (mediaId, projectId, output path). */
  subjectId?: string
  result?: unknown
  /** Whether the job honours `job:cancel` (it registered an abort path). */
  cancelable: boolean
  /** Epoch ms the job started — the renderer derives elapsed time / ETA from it. */
  startedAt: number
}

/** Event pushed from main → renderer over IPC as a job advances. */
export interface JobProgressEvent {
  id: string
  type: JobType
  status: JobStatus
  progress: number
  label: string
  /** mediaId / projectId / output path the job concerns (lets the UI react). */
  subjectId?: string
  error?: string
  cancelable: boolean
  startedAt: number
}

/** Whether a job is still in flight (not yet done / failed / canceled). */
export function isJobActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running'
}

/**
 * Remaining seconds for a running job, extrapolated linearly from its progress
 * so far — or null while there is too little signal to say anything honest
 * (the first few percent / seconds are dominated by startup cost: model load,
 * GPU warm-up, the decoder seeking to the in-point).
 */
export function jobEtaSec(progress: number, startedAt: number, now: number): number | null {
  const elapsed = (now - startedAt) / 1000
  if (!(progress >= 0.03) || progress >= 1 || elapsed < 3) return null
  return (elapsed * (1 - progress)) / progress
}

/** "45s" / "3m 20s" — the compact remaining-time label the job UI shows. */
export function formatEta(sec: number): string {
  const s = Math.max(1, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}
