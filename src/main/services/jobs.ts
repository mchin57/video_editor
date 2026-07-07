/** In-memory job registry that broadcasts progress to all renderer windows. */

import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_EVENT } from '@shared/ipc'
import type { Job, JobType, JobProgressEvent } from '@shared/jobs'

const jobs = new Map<string, Job>()

function broadcast(job: Job): void {
  const ev: JobProgressEvent = {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    label: job.label,
    subjectId: job.subjectId,
    error: job.error
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC_EVENT.jobProgress, ev)
  }
}

/** Finished jobs kept for listJobs history; older ones are evicted. */
const FINISHED_KEEP = 50

export function createJob(type: JobType, label: string, subjectId?: string): Job {
  // Evict the oldest finished jobs so the registry doesn't grow unbounded over
  // a long session (Map iteration order = insertion order = age).
  const finished = [...jobs.values()].filter((j) => j.status !== 'queued' && j.status !== 'running')
  for (const j of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) jobs.delete(j.id)

  const job: Job = { id: randomUUID(), type, status: 'running', progress: 0, label, subjectId }
  jobs.set(job.id, job)
  broadcast(job)
  return job
}

export function setProgress(id: string, progress: number): void {
  const job = jobs.get(id)
  if (!job) return
  job.progress = progress
  job.status = 'running'
  broadcast(job)
}

export function finishJob(id: string, result?: unknown): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = 'done'
  job.progress = 1
  job.result = result
  broadcast(job)
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = 'error'
  job.error = error
  broadcast(job)
}

export function listJobs(): Job[] {
  return [...jobs.values()]
}
