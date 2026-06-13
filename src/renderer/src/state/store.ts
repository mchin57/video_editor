import { create } from 'zustand'
import type { JobProgressEvent, JobStatus } from '@shared/jobs'

export interface ProxyJobState {
  progress: number
  status: JobStatus
  error?: string
}

interface EditorState {
  /** Currently selected media asset id (drives the preview). */
  selectedId: string | null
  select: (id: string | null) => void

  /** Proxy job state keyed by mediaId. */
  proxyJobs: Record<string, ProxyJobState>
  applyJobEvent: (ev: JobProgressEvent) => void
}

export const useEditor = create<EditorState>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),

  proxyJobs: {},
  applyJobEvent: (ev) =>
    set((state) => {
      if (ev.type !== 'proxy' || !ev.subjectId) return state
      return {
        proxyJobs: {
          ...state.proxyJobs,
          [ev.subjectId]: { progress: ev.progress, status: ev.status, error: ev.error }
        }
      }
    })
}))
