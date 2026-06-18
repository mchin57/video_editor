import { create } from 'zustand'
import type {
  AudioClip,
  CaptionSegment,
  CaptionsConfig,
  ColorAdjust,
  CropRect,
  ImageOverlay,
  Project,
  ScriptLine,
  TextOverlay
} from '@shared/project'
import { createEmptyProject, migrateProject } from '@shared/project'
import type { PresetId } from '@shared/export'
import { clipStartTimes, reorder, splitClip, timelineDuration } from '@/lib/timeline'
import {
  loadProject,
  openProjectFile,
  saveProject,
  saveProjectAs,
  writeProjectFile
} from '@/ipc/client'

const HISTORY_LIMIT = 50

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(project: Project): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveProject(project), 400)
}

const newId = (): string => crypto.randomUUID()

/**
 * The file binding (which .reel file, and whether there are unsaved changes)
 * lives outside the project document so it survives a relaunch without polluting
 * the saved JSON. The document itself is autosaved separately as the working copy.
 */
const SESSION_KEY = 'projectSession'
interface Session {
  filePath: string | null
  dirty: boolean
}
function loadSession(): Session {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}')
    return { filePath: typeof s.filePath === 'string' ? s.filePath : null, dirty: Boolean(s.dirty) }
  } catch {
    return { filePath: null, dirty: false }
  }
}
function saveSession(filePath: string | null, dirty: boolean): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ filePath, dirty }))
  } catch {
    /* localStorage is a convenience; ignore write failures */
  }
}

const DISCARD_PROMPT = 'Discard unsaved changes to the current project?'

interface ProjectState {
  project: Project | null
  past: Project[]
  future: Project[]
  selectedClipId: string | null
  loaded: boolean
  /** Path of the bound .reel file, or null if this project was never saved to one. */
  filePath: string | null
  /** Whether there are edits since the last file Save/Open. */
  dirty: boolean

  load: () => Promise<void>
  /** File ▸ New — start a blank project (prompts if there are unsaved changes). */
  newProjectFile: () => void
  /** File ▸ Open… — pick a .reel file (prompts if there are unsaved changes). */
  openFile: () => Promise<void>
  /** File ▸ Save — write to the bound file, or fall back to Save As… if unbound. */
  save: () => Promise<void>
  /** File ▸ Save As… — choose a new .reel file and bind to it. */
  saveAs: () => Promise<void>
  selectClip: (id: string | null) => void
  setPreset: (preset: PresetId) => void
  /** Add imported media to this project's library (deduped, recorded for undo). */
  addMedia: (ids: string[]) => void
  /** Remove media from this project's library. Does NOT delete it from disk. */
  removeMedia: (id: string) => void
  /** Update the project without recording history (for live drag previews). */
  liveUpdate: (transform: (p: Project) => Project) => void
  /** Close a live interaction: push the pre-drag snapshot as one undo step. */
  commitLive: (before: Project) => void
  addClip: (mediaId: string, durationSec: number, hasAudio?: boolean) => void
  removeClip: (clipId: string) => void
  reorderClips: (from: number, to: number) => void
  trimClip: (clipId: string, inSec: number, outSec: number) => void
  splitClipAt: (clipId: string, localTime: number) => void
  toggleMute: (clipId: string) => void
  setClipCrop: (clipId: string, crop: CropRect | null) => void
  setClipColor: (clipId: string, color: ColorAdjust | null) => void
  addOverlay: (overlay: TextOverlay) => void
  updateOverlay: (id: string, patch: Partial<TextOverlay>) => void
  removeOverlay: (id: string) => void
  addImageOverlay: (overlay: ImageOverlay) => void
  updateImageOverlay: (id: string, patch: Partial<ImageOverlay>) => void
  removeImageOverlay: (id: string) => void
  setCaptions: (captions: CaptionsConfig) => void
  addScriptLine: (atSec: number | null) => void
  updateScriptLine: (id: string, patch: Partial<ScriptLine>) => void
  removeScriptLine: (id: string) => void
  updateCaption: (id: string, patch: Partial<CaptionSegment>) => void
  removeCaption: (id: string) => void
  addAudioClip: (clip: AudioClip) => void
  updateAudioClip: (id: string, patch: Partial<AudioClip>) => void
  removeAudioClip: (id: string) => void
  /** Pull a video clip's audio onto the audio track and mute the clip. */
  extractClipAudio: (clipId: string) => void
  /** Replace an audio clip with one clip per speech segment (source-time ranges). */
  splitAudioOnSilence: (audioId: string, ranges: { start: number; end: number }[]) => void
  undo: () => void
  redo: () => void
}

export const useProject = create<ProjectState>((set, get) => {
  /** Flag the document as changed-since-last-file-save and persist the binding. */
  function markDirty(): void {
    if (!get().dirty) set({ dirty: true })
    saveSession(get().filePath, true)
  }

  /** Apply a pure transform, recording undo history and autosaving. */
  function commit(transform: (p: Project) => Project): void {
    const current = get().project
    if (!current) return
    const next = transform(current)
    if (next === current) return
    set({ project: next, past: [...get().past, current].slice(-HISTORY_LIMIT), future: [] })
    scheduleSave(next)
    markDirty()
  }

  /** Switch to a different project document, resetting history and selection. */
  function adopt(project: Project, filePath: string | null): void {
    set({ project, past: [], future: [], selectedClipId: null, filePath, dirty: false })
    saveSession(filePath, false)
    scheduleSave(project) // keep the working copy in sync with what's on screen
  }

  return {
    project: null,
    past: [],
    future: [],
    selectedClipId: null,
    loaded: false,
    filePath: null,
    dirty: false,

    load: async () => {
      const project = migrateProject(await loadProject())
      const session = loadSession()
      set({ project, loaded: true, past: [], future: [], ...session })
    },

    newProjectFile: () => {
      if (get().dirty && !window.confirm(DISCARD_PROMPT)) return
      adopt(createEmptyProject(newId(), 'Untitled Reel'), null)
    },

    openFile: async () => {
      if (get().dirty && !window.confirm(DISCARD_PROMPT)) return
      const res = await openProjectFile()
      if (!res) return
      adopt(migrateProject(res.project), res.path)
    },

    save: async () => {
      const { project, filePath } = get()
      if (!project) return
      if (!filePath) return get().saveAs()
      await writeProjectFile(project, filePath)
      set({ dirty: false })
      saveSession(filePath, false)
    },

    saveAs: async () => {
      const { project } = get()
      if (!project) return
      const res = await saveProjectAs(project)
      if (!res) return
      // The chosen filename becomes the project name; reflect it in the working copy.
      set({ project: res.project, filePath: res.path, dirty: false })
      saveSession(res.path, false)
      scheduleSave(res.project)
    },

    selectClip: (id) => set({ selectedClipId: id }),

    setPreset: (preset) => commit((p) => ({ ...p, preset })),

    addMedia: (ids) =>
      commit((p) => {
        const add = ids.filter((id) => !p.mediaIds.includes(id))
        return add.length ? { ...p, mediaIds: [...p.mediaIds, ...add] } : p
      }),

    removeMedia: (id) =>
      commit((p) =>
        p.mediaIds.includes(id) ? { ...p, mediaIds: p.mediaIds.filter((m) => m !== id) } : p
      ),

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
      markDirty()
    },

    addClip: (mediaId, durationSec, hasAudio = false) =>
      commit((p) => {
        const out = Math.max(0.1, durationSec)
        const startSec = timelineDuration(p.clips) // appended at the current end
        const clip = { id: newId(), mediaId, inSec: 0, outSec: out, crop: null, mute: hasAudio, gainDb: 0 }
        // Auto-extract the clip's audio onto the audio track (and mute the clip),
        // so dialogue can be mixed independently.
        const audioClips = hasAudio
          ? [
              ...p.audioClips,
              {
                id: newId(),
                mediaId,
                startSec,
                inSec: 0,
                outSec: out,
                gainDb: 0,
                fadeInSec: 0,
                fadeOutSec: 0,
                duck: false,
                kind: 'extracted' as const
              }
            ]
          : p.audioClips
        return { ...p, clips: [...p.clips, clip], audioClips }
      }),

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

    setClipColor: (clipId, color) =>
      commit((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === clipId ? { ...c, color: color ?? undefined } : c))
      })),

    addOverlay: (overlay) => commit((p) => ({ ...p, overlays: [...p.overlays, overlay] })),

    updateOverlay: (id, patch) =>
      commit((p) => ({
        ...p,
        overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o))
      })),

    removeOverlay: (id) => commit((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== id) })),

    addImageOverlay: (overlay) =>
      commit((p) => ({ ...p, imageOverlays: [...p.imageOverlays, overlay] })),

    updateImageOverlay: (id, patch) =>
      commit((p) => ({
        ...p,
        imageOverlays: p.imageOverlays.map((o) => (o.id === id ? { ...o, ...patch } : o))
      })),

    removeImageOverlay: (id) =>
      commit((p) => ({ ...p, imageOverlays: p.imageOverlays.filter((o) => o.id !== id) })),

    setCaptions: (captions) => commit((p) => ({ ...p, captions })),

    addScriptLine: (atSec) =>
      commit((p) => ({ ...p, script: [...p.script, { id: newId(), text: '', atSec }] })),

    updateScriptLine: (id, patch) =>
      commit((p) => ({
        ...p,
        script: p.script.map((l) => (l.id === id ? { ...l, ...patch } : l))
      })),

    removeScriptLine: (id) => commit((p) => ({ ...p, script: p.script.filter((l) => l.id !== id) })),

    updateCaption: (id, patch) =>
      commit((p) => ({
        ...p,
        captions: {
          ...p.captions,
          segments: p.captions.segments.map((s) => (s.id === id ? { ...s, ...patch } : s))
        }
      })),

    removeCaption: (id) =>
      commit((p) => ({
        ...p,
        captions: { ...p.captions, segments: p.captions.segments.filter((s) => s.id !== id) }
      })),

    addAudioClip: (clip) => commit((p) => ({ ...p, audioClips: [...p.audioClips, clip] })),

    updateAudioClip: (id, patch) =>
      commit((p) => ({
        ...p,
        audioClips: p.audioClips.map((a) => (a.id === id ? { ...a, ...patch } : a))
      })),

    removeAudioClip: (id) =>
      commit((p) => ({ ...p, audioClips: p.audioClips.filter((a) => a.id !== id) })),

    splitAudioOnSilence: (audioId, ranges) =>
      commit((p) => {
        const idx = p.audioClips.findIndex((a) => a.id === audioId)
        if (idx < 0 || ranges.length === 0) return p
        const orig = p.audioClips[idx]
        const pieces: AudioClip[] = ranges.map((r) => ({
          ...orig,
          id: newId(),
          inSec: r.start,
          outSec: r.end,
          startSec: orig.startSec + (r.start - orig.inSec),
          fadeInSec: 0,
          fadeOutSec: 0
        }))
        const audioClips = p.audioClips.slice()
        audioClips.splice(idx, 1, ...pieces)
        return { ...p, audioClips }
      }),

    extractClipAudio: (clipId) =>
      commit((p) => {
        const idx = p.clips.findIndex((c) => c.id === clipId)
        if (idx < 0) return p
        const clip = p.clips[idx]
        const startSec = clipStartTimes(p.clips)[idx]
        const audio: AudioClip = {
          id: newId(),
          mediaId: clip.mediaId,
          startSec,
          inSec: clip.inSec,
          outSec: clip.outSec,
          gainDb: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
          duck: false,
          kind: 'extracted'
        }
        return {
          ...p,
          clips: p.clips.map((c) => (c.id === clipId ? { ...c, mute: true } : c)),
          audioClips: [...p.audioClips, audio]
        }
      }),

    undo: () => {
      const { past, project, future } = get()
      if (!project || past.length === 0) return
      const prev = past[past.length - 1]
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future] })
      scheduleSave(prev)
      markDirty()
    },

    redo: () => {
      const { future, project, past } = get()
      if (!project || future.length === 0) return
      const next = future[0]
      set({ project: next, future: future.slice(1), past: [...past, project] })
      scheduleSave(next)
      markDirty()
    }
  }
})
