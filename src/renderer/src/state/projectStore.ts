import { create } from 'zustand'
import type { CaptionsConfig, CropRect, Project, TextOverlay } from '@shared/project'
import { reorder, splitClip } from '@/lib/timeline'
import { loadProject, saveProject } from '@/ipc/client'

const HISTORY_LIMIT = 50

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(project: Project): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveProject(project), 400)
}

const newId = (): string => crypto.randomUUID()

interface ProjectState {
  project: Project | null
  past: Project[]
  future: Project[]
  selectedClipId: string | null
  loaded: boolean

  load: () => Promise<void>
  selectClip: (id: string | null) => void
  /** Update the project without recording history (for live drag previews). */
  liveUpdate: (transform: (p: Project) => Project) => void
  /** Close a live interaction: push the pre-drag snapshot as one undo step. */
  commitLive: (before: Project) => void
  addClip: (mediaId: string, durationSec: number) => void
  removeClip: (clipId: string) => void
  reorderClips: (from: number, to: number) => void
  trimClip: (clipId: string, inSec: number, outSec: number) => void
  splitClipAt: (clipId: string, localTime: number) => void
  toggleMute: (clipId: string) => void
  setClipCrop: (clipId: string, crop: CropRect | null) => void
  addOverlay: (overlay: TextOverlay) => void
  updateOverlay: (id: string, patch: Partial<TextOverlay>) => void
  removeOverlay: (id: string) => void
  setCaptions: (captions: CaptionsConfig) => void
  undo: () => void
  redo: () => void
}

export const useProject = create<ProjectState>((set, get) => {
  /** Apply a pure transform, recording undo history and autosaving. */
  function commit(transform: (p: Project) => Project): void {
    const current = get().project
    if (!current) return
    const next = transform(current)
    if (next === current) return
    set({ project: next, past: [...get().past, current].slice(-HISTORY_LIMIT), future: [] })
    scheduleSave(next)
  }

  return {
    project: null,
    past: [],
    future: [],
    selectedClipId: null,
    loaded: false,

    load: async () => {
      const project = await loadProject()
      set({ project, loaded: true, past: [], future: [] })
    },

    selectClip: (id) => set({ selectedClipId: id }),

    liveUpdate: (transform) => {
      const current = get().project
      if (!current) return
      set({ project: transform(current) })
    },

    commitLive: (before) => {
      const current = get().project
      if (!current || current === before) return
      set({ past: [...get().past, before].slice(-HISTORY_LIMIT), future: [] })
      scheduleSave(current)
    },

    addClip: (mediaId, durationSec) =>
      commit((p) => ({
        ...p,
        clips: [
          ...p.clips,
          {
            id: newId(),
            mediaId,
            inSec: 0,
            outSec: Math.max(0.1, durationSec),
            crop: null,
            mute: false,
            gainDb: 0
          }
        ]
      })),

    removeClip: (clipId) => {
      commit((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== clipId) }))
      if (get().selectedClipId === clipId) set({ selectedClipId: null })
    },

    reorderClips: (from, to) => commit((p) => ({ ...p, clips: reorder(p.clips, from, to) })),

    trimClip: (clipId, inSec, outSec) =>
      commit((p) => ({
        ...p,
        clips: p.clips.map((c) => {
          if (c.id !== clipId) return c
          const i = Math.max(0, Math.min(inSec, outSec - 0.05))
          const o = Math.max(i + 0.05, outSec)
          return { ...c, inSec: i, outSec: o }
        })
      })),

    splitClipAt: (clipId, localTime) =>
      commit((p) => {
        const idx = p.clips.findIndex((c) => c.id === clipId)
        if (idx < 0) return p
        const res = splitClip(p.clips[idx], localTime, newId)
        if (!res) return p
        const clips = p.clips.slice()
        clips.splice(idx, 1, res[0], res[1])
        return { ...p, clips }
      }),

    toggleMute: (clipId) =>
      commit((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === clipId ? { ...c, mute: !c.mute } : c))
      })),

    setClipCrop: (clipId, crop) =>
      commit((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === clipId ? { ...c, crop } : c))
      })),

    addOverlay: (overlay) => commit((p) => ({ ...p, overlays: [...p.overlays, overlay] })),

    updateOverlay: (id, patch) =>
      commit((p) => ({
        ...p,
        overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o))
      })),

    removeOverlay: (id) => commit((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== id) })),

    setCaptions: (captions) => commit((p) => ({ ...p, captions })),

    undo: () => {
      const { past, project, future } = get()
      if (!project || past.length === 0) return
      const prev = past[past.length - 1]
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future] })
      scheduleSave(prev)
    },

    redo: () => {
      const { future, project, past } = get()
      if (!project || future.length === 0) return
      const next = future[0]
      set({ project: next, future: future.slice(1), past: [...past, project] })
      scheduleSave(next)
    }
  }
})
