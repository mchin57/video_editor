/** In-memory job registry that broadcasts progress to all renderer windows. */

import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_EVENT } from '@shared/ipc'
import type { Job, JobType, JobProgressEvent } from '@shared/jobs'

const jobs = new Map<string, Job>()
/** Abort controllers of cancelable jobs still in flight, by job id. */
const aborts = new Map<string, AbortController>()
/** The library media ids a job still in flight READS (its `uses`), by job id:
 *  a Rename refuses while one of them is running (`activeJobUsing`). */
const uses = new Map<string, Set<string>>()

function broadcast(job: Job): void {
  const ev: JobProgressEvent = {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    label: job.label,
    subjectId: job.subjectId,
    error: job.error,
    cancelable: job.cancelable,
    startedAt: job.startedAt
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC_EVENT.jobProgress, ev)
  }
}

/** Finished jobs kept for listJobs history; older ones are evicted. */
const FINISHED_KEEP = 50

/** A running job plus, for a cancelable one, the signal its work must honour. */
export type RunningJob = Job & { signal?: AbortSignal }

/**
 * Register a job. `cancelable` jobs get an AbortSignal (returned as
 * `job.signal`) that `cancelJob` fires: the job's own code must then stop its
 * work, kill whatever it spawned and remove partial output, and report the
 * outcome through `failJob` — which records it as `canceled`, not `error`,
 * once the signal has fired.
 *
 * `uses` lists the library media ids whose originals the job reads, so a
 * Rename can refuse while it runs (`activeJobUsing`).
 */
export function createJob(
  type: JobType,
  label: string,
  subjectId?: string,
  opts: { cancelable?: boolean; uses?: string[] } = {}
): RunningJob {
  // Evict the oldest finished jobs so the registry doesn't grow unbounded over
  // a long session (Map iteration order = insertion order = age).
  const finished = [...jobs.values()].filter((j) => j.status !== 'queued' && j.status !== 'running')
  for (const j of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) jobs.delete(j.id)

  const cancelable = !!opts.cancelable
  const job: Job = {
    id: randomUUID(),
    type,
    status: 'running',
    progress: 0,
    label,
    subjectId,
    cancelable,
    startedAt: Date.now()
  }
  jobs.set(job.id, job)
  if (opts.uses?.length) uses.set(job.id, new Set(opts.uses))
  let signal: AbortSignal | undefined
  if (cancelable) {
    const ac = new AbortController()
    aborts.set(job.id, ac)
    signal = ac.signal
  }
  broadcast(job)
  return { ...job, signal }
}

export function setProgress(id: string, progress: number): void {
  const job = jobs.get(id)
  if (!job || job.status !== 'running') return
  job.progress = progress
  broadcast(job)
}

/** Replace a running job's label (e.g. once it knows which device it runs on). */
export function setLabel(id: string, label: string): void {
  const job = jobs.get(id)
  if (!job || job.status !== 'running') return
  job.label = label
  broadcast(job)
}

export function finishJob(id: string, result?: unknown): void {
  const job = jobs.get(id)
  if (!job) return
  aborts.delete(id)
  uses.delete(id)
  job.status = 'done'
  job.progress = 1
  job.result = result
  broadcast(job)
}

/** End a job that threw. After `cancelJob` fired its signal the throw is the
 *  cancellation unwinding, so it is recorded as `canceled` rather than `error`. */
export function failJob(id: string, error: string): void {
  const job = jobs.get(id)
  if (!job) return
  const canceled = aborts.get(id)?.signal.aborted ?? false
  aborts.delete(id)
  uses.delete(id)
  job.status = canceled ? 'canceled' : 'error'
  if (!canceled) job.error = error
  broadcast(job)
}

/** Whether `cancelJob` has fired for this job (false for unknown/finished ids). */
export function isJobCanceled(id: string): boolean {
  return aborts.get(id)?.signal.aborted ?? false
}

/**
 * Ask a running cancelable job to stop. Returns false when there is nothing to
 * cancel (unknown id, not cancelable, or already finished). The job reports its
 * own end state once its work has actually unwound (see `failJob`).
 */
export function cancelJob(id: string): boolean {
  const ac = aborts.get(id)
  if (!ac || ac.signal.aborted) return false
  ac.abort()
  return true
}

/** A job still in flight that reads this media's original, if any. */
export function activeJobUsing(mediaId: string): Job | null {
  for (const [id, ids] of uses) {
    const job = jobs.get(id)
    if (job && (job.status === 'queued' || job.status === 'running') && ids.has(mediaId)) return job
  }
  return null
}

export function listJobs(): Job[] {
  return [...jobs.values()]
}
