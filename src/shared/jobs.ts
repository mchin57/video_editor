/** Long-running background work (proxy generation, transcription, export). */

export type JobType = 'proxy' | 'transcribe' | 'export'
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
}
