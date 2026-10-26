/**
 * The project store's core: the open document and its undo history, and the
 * one way every action changes it (`commit` / `commitComp`). The actions
 * themselves live in slices beside this file, each built on the `Doc` this
 * module hands them, and `state/projectStore.ts` assembles them into the ONE
 * `useProject` store — so components and e2e specs see a single store, and
 * history, autosave and the active composition behave the same for every
 * action.
 */

import type { StoreApi } from 'zustand'
import type { Composition, Layer, Project, VideoContent } from '@shared/project'
import type { GraphicMark } from '@shared/graphics'
import type { WorkoutWidget } from '@shared/workoutOverlay'
import { migrateProject } from '@shared/project'
import {
  MAX_COMP_DEPTH,
  resolveCompAtPath,
  syncCompoundWindows,
  updateCompAtPath,
  type CompPath,
  type CompStep
} from '@shared/compositions'
import { presetFor, type ExportPreset } from '@shared/formats'
import { updateById } from '@/lib/arrays'
import { saveProject } from '@/ipc/client'
import { useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
import type { FileActions } from './fileActions'
import type { RootActions } from './rootActions'
import type { LayerActions } from './layerActions'
import type { VideoTimingActions } from './videoTimingActions'
import type { TimelineActions } from './timelineActions'
import type { CaptionActions } from './captionActions'
import type { AudioActions } from './audioActions'

const HISTORY_LIMIT = 50

export interface DocumentState {
  project: Project | null
  past: Project[]
  future: Project[]
  loaded: boolean
  /** The open project's .reel, or null when no project is open (start screen). */
  filePath: string | null
  /** Why no project opened at launch (shown on the start screen). */
  launchMessage: string | null
  /** Whether there are edits since the last file Save/Open. */
  dirty: boolean
  /**
   * Which composition the editor is pointed at: `[]` = the root project
   * (today's behavior), else the steps into nested comps (compound layers /
   * layout cells). EVERY timeline-editing action operates on the composition at
   * this path via `updateCompAtPath` — the same action code edits the root and
   * any nested doc. Undo/redo/open revalidate it (a path the new document can't
   * resolve pops to the root).
   */
  editPath: CompPath
}

export interface HistoryActions {
  /** Update the ACTIVE composition without recording history (live drag
   *  previews). The transform sees the active comp (the root when `editPath`
   *  is empty) and must derive its result by spreading its input. */
  liveUpdate: (transform: (c: Composition) => Composition) => void
  /** Live update for ROOT-ONLY fields (script), bypassing the composition
   *  indirection — a script marker drag must edit the root even while the
   *  editor is inside a nested comp. */
  liveUpdateRoot: (transform: (p: Project) => Project) => void
  /** Close a live interaction: push the pre-drag snapshot as one undo step. */
  commitLive: (before: Project) => void
  /** Open a GESTURE (a slider drag): until `endGesture`, ordinary actions still
   *  apply and autosave but record no history, and closing the gesture records
   *  the whole thing as ONE undo step. Unlike `liveUpdate` it needs no special
   *  transform, so any control that edits through normal actions can use it. */
  beginGesture: () => void
  endGesture: () => void
  /** Step the editor INTO a nested composition (a compound layer, or a layout
   *  cell that carries a comp). No-ops if the step doesn't resolve or the
   *  depth cap is hit. Clears selection and rewinds the playhead. */
  enterComposition: (step: CompStep) => void
  /** Step back out one level (to the parent composition). */
  exitComposition: () => void
  /** Flush a pending debounced autosave immediately (window unload can land
   *  inside the 400ms debounce window and lose the last edit). */
  flushSave: () => void
  undo: () => void
  redo: () => void
}

export type ProjectState = DocumentState &
  HistoryActions &
  FileActions &
  RootActions &
  LayerActions &
  VideoTimingActions &
  TimelineActions &
  CaptionActions &
  AudioActions

/**
 * Selector: the composition the editor is pointed at — the root project when
 * `editPath` is empty, else the nested comp it addresses. A pure walk of the
 * current document (stable references, so zustand won't re-render spuriously).
 * Every timeline-rendering surface reads through this, so entering a comp
 * automatically re-targets the whole editor. Null only when no project (or,
 * transiently, if the path fails mid-update — callers treat it like "empty").
 */
export const activeComp = (s: Pick<ProjectState, 'project' | 'editPath'>): Composition | null =>
  s.project ? resolveCompAtPath(s.project, s.editPath) : null

/**
 * The project's output format (aspect ratio + frame window), root-scoped: a
 * nested comp is edited and rendered through the same frame. Returns the
 * registry's own object, so it is a stable selector result.
 */
export const projectFormat = (s: Pick<ProjectState, 'project'>): ExportPreset => presetFor(s.project?.preset)

// --- Autosave: the working copy follows every edit, debounced ----------------

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(project: Project): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveProject(project), 400)
}

/** Drop a pending autosave — before a Save, which writes the same content and
 *  deletes the autosave (a late one would mark the project dirty again).
 *  True when one was pending. */
function cancelScheduledSave(): boolean {
  if (!saveTimer) return false
  clearTimeout(saveTimer)
  saveTimer = null
  return true
}

/** Leaving the current view of the edit (another document, another comp):
 *  nothing stays selected and the playhead stops at 0. */
function resetEditorView(): void {
  useUi.getState().clearSelection()
  usePlayback.getState().setPlaying(false)
  usePlayback.getState().setTime(0)
}

type SetState = StoreApi<ProjectState>['setState']
type GetState = StoreApi<ProjectState>['getState']

/** What every action slice builds on. */
export interface Doc {
  set: SetState
  get: GetState
  /** Apply a pure ROOT-document transform, recording undo history and
   *  autosaving. Root-only actions (preset, media list, script, project-wide
   *  defaults) use this directly; timeline edits go through `commitComp`. */
  commit: (transform: (p: Project) => Project) => void
  /** Apply a pure transform to the ACTIVE composition (the root when
   *  `editPath` is empty — then `transform` receives the project itself, so
   *  behavior is byte-identical to `commit`). THE indirection that lets every
   *  timeline action edit root and nested docs with one implementation. */
  commitComp: (transform: (c: Composition) => Composition) => void
  /** Switch to a different project document, resetting history, selection and
   *  the playhead. No autosave: main already holds this document's state (an
   *  autosave exists only once there are unsaved edits). */
  adopt: (project: Project, filePath: string, dirty?: boolean) => void
  markDirty: () => void
  scheduleSave: (project: Project) => void
  cancelScheduledSave: () => boolean
}

/** `c` with layer `id` replaced by `fn(layer)`. */
export const mapLayer = (c: Composition, id: string, fn: (l: Layer) => Layer): Composition => ({
  ...c,
  layers: updateById(c.layers, id, fn)
})

/** `c` with VIDEO layer `id` replaced by `fn(layer, content)`; any other kind
 *  is left as it is. */
export const mapVideoLayer = (
  c: Composition,
  id: string,
  fn: (l: Layer, content: VideoContent) => Layer
): Composition => mapLayer(c, id, (l) => (l.content.kind === 'video' ? fn(l, l.content) : l))

/** `c` with WORKOUT layer `id`'s widgets replaced by `fn(widgets)`; any other
 *  kind is left as it is. */
export const mapWorkoutWidgets = (
  c: Composition,
  id: string,
  fn: (widgets: WorkoutWidget[]) => WorkoutWidget[]
): Composition =>
  mapLayer(c, id, (l) =>
    l.content.kind === 'workout' ? { ...l, content: { ...l.content, widgets: fn(l.content.widgets) } } : l
  )

/** `c` with GRAPHICS layer `id`'s marks replaced by `fn(marks)`; any other
 *  kind is left as it is. */
export const mapGraphicsMarks = (
  c: Composition,
  id: string,
  fn: (marks: GraphicMark[]) => GraphicMark[]
): Composition =>
  mapLayer(c, id, (l) =>
    l.content.kind === 'graphics' ? { ...l, content: { ...l.content, marks: fn(l.content.marks) } } : l
  )

/** Build the document core: its `Doc` for the slices, and its own state and
 *  history actions. */
export function createDocument(set: SetState, get: GetState): { doc: Doc; state: DocumentState & HistoryActions } {
  /** The pre-gesture snapshot while a gesture is open (`beginGesture`). */
  let gestureBefore: Project | null = null

  function markDirty(): void {
    if (!get().dirty) set({ dirty: true })
  }

  function commit(transform: (p: Project) => Project): void {
    const current = get().project
    if (!current) return
    // Editing inside a compound changes how long it plays, so its parent block
    // has to follow (v1 comps are untrimmed — the window IS the duration).
    // A no-op sync returns the same object, so this can't churn history.
    const next = syncCompoundWindows(transform(current)) as Project
    if (next === current) return
    if (gestureBefore) set({ project: next })
    else set({ project: next, past: [...get().past, current].slice(-HISTORY_LIMIT), future: [] })
    scheduleSave(next)
    markDirty()
  }

  function adopt(project: Project, filePath: string, dirty = false): void {
    // The playhead belongs to the old document: a new or opened project starts at 0.
    resetEditorView()
    gestureBefore = null // a gesture can't span documents
    set({ project: migrateProject(project), past: [], future: [], filePath, dirty, editPath: [], launchMessage: null })
  }

  /** After a history jump or reload, a stored `editPath` may point into a
   *  composition the new document doesn't have (e.g. undoing the conversion
   *  that created it) — pop to the root rather than dangle. */
  function revalidateEditPath(project: Project): void {
    const path = get().editPath
    if (path.length && !resolveCompAtPath(project, path)) {
      useUi.getState().clearSelection()
      set({ editPath: [] })
    }
  }

  /** Step through history to `project`, keeping the comp being edited valid. */
  function jumpTo(project: Project, history: Pick<DocumentState, 'past' | 'future'>): void {
    set({ project, ...history })
    revalidateEditPath(project)
    scheduleSave(project)
    markDirty()
  }

  const doc: Doc = {
    set,
    get,
    commit,
    commitComp: (transform) => commit((p) => updateCompAtPath(p, get().editPath, transform)),
    adopt,
    markDirty,
    scheduleSave,
    cancelScheduledSave
  }

  const state: DocumentState & HistoryActions = {
    project: null,
    past: [],
    future: [],
    loaded: false,
    filePath: null,
    launchMessage: null,
    dirty: false,
    editPath: [],

    liveUpdate: (transform) => {
      const current = get().project
      if (!current) return
      set({ project: updateCompAtPath(current, get().editPath, transform) })
    },

    liveUpdateRoot: (transform) => {
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

    beginGesture: () => {
      if (!gestureBefore) gestureBefore = get().project
    },

    endGesture: () => {
      const before = gestureBefore
      gestureBefore = null
      if (before) get().commitLive(before)
    },

    enterComposition: (step) => {
      const { project, editPath } = get()
      if (!project) return
      const path = [...editPath, step]
      // The step must resolve, and the target must sit within the depth cap
      // (root = depth 1, so a path of length L edits at depth L + 1).
      if (path.length + 1 > MAX_COMP_DEPTH || !resolveCompAtPath(project, path)) return
      resetEditorView()
      set({ editPath: path })
    },

    exitComposition: () => {
      const { editPath } = get()
      if (editPath.length === 0) return
      resetEditorView()
      set({ editPath: editPath.slice(0, -1) })
    },

    flushSave: () => {
      if (!cancelScheduledSave()) return
      const p = get().project
      // Fire-and-forget: the invoke reaches the main process before the window
      // tears down, and main outlives the renderer to finish the write.
      if (p) void saveProject(p)
    },

    undo: () => {
      get().endGesture() // an open gesture is closed (recorded) before stepping back
      const { past, project, future } = get()
      if (!project || past.length === 0) return
      jumpTo(past[past.length - 1], { past: past.slice(0, -1), future: [project, ...future] })
    },

    redo: () => {
      get().endGesture()
      const { future, project, past } = get()
      if (!project || future.length === 0) return
      jumpTo(future[0], { future: future.slice(1), past: [...past, project] })
    }
  }

  return { doc, state }
}
