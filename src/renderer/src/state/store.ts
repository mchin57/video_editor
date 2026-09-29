import { create } from 'zustand'
import type { JobProgressEvent, JobType } from '@shared/jobs'
import { isJobActive } from '@shared/jobs'

/** Completed/canceled jobs kept for the job list. Running jobs and failures are
 *  never evicted — a failure stays visible (header indicator, Library badge)
 *  until dismissed or superseded. */
const FINISHED_KEEP = 30

interface EditorState {
  /** Currently selected media asset id (drives the preview). */
  selectedId: string | null
  select: (id: string | null) => void

  /**
   * Every background job this session has heard about, keyed by job id, in the
   * order they started — the latest `job:progress` event for each. ONE source
   * of truth for every job surface: the header's job indicator, the Library's
   * proxy badges, the Export button and the Inspector's matte button all read
   * it through the selectors below.
   */
  jobs: Record<string, JobProgressEvent>
  applyJobEvent: (ev: JobProgressEvent) => void
  /** Forget a finished job (the job list's dismiss). No-op while it runs. */
  dismissJob: (id: string) => void
}

export const useEditor = create<EditorState>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),

  jobs: {},
  applyJobEvent: (ev) =>
    set((state) => {
      const jobs = { ...state.jobs, [ev.id]: ev }
      const finished = Object.values(jobs).filter((j) => j.status === 'done' || j.status === 'canceled')
      for (const j of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) delete jobs[j.id]
      return { jobs }
    }),
  dismissJob: (id) =>
    set((state) => {
      const job = state.jobs[id]
      if (!job || isJobActive(job.status)) return state
      const jobs = { ...state.jobs }
      delete jobs[id]
      return { jobs }
    })
}))

/** The most recent job of `type` about `subjectId` (a mediaId for proxies, the
 *  layer id for a matte), or undefined. Returns the stored event object, so it
 *  is a stable zustand selector result. */
export function latestJob(
  jobs: Record<string, JobProgressEvent>,
  type: JobType,
  subjectId?: string
): JobProgressEvent | undefined {
  let found: JobProgressEvent | undefined
  for (const j of Object.values(jobs)) {
    if (j.type === type && (subjectId === undefined || j.subjectId === subjectId)) found = j
  }
  return found
}
