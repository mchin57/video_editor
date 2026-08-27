import { create } from 'zustand'
import type {
  AudioClip,
  CaptionsConfig,
  Composition,
  ImageContent,
  Layer,
  LayoutCell,
  Project,
  ScriptLine,
  TextContent,
  TimelineItemRef,
  VideoContent
} from '@shared/project'
import { createEmptyProject, migrateProject, videoSpeed } from '@shared/project'
import {
  MAX_COMP_DEPTH,
  compDepth,
  makeCompFromCell,
  makeCompFromLayer,
  resolveCompAtPath,
  syncCompoundWindows,
  updateCompAtPath,
  type CompPath,
  type CompStep
} from '@shared/compositions'
import {
  applyVisibleOrder,
  FRAME,
  layerTransformAt,
  makeVideoLayer,
  playedVideoDuration,
  upsertKeyframe,
  videoSourceTime
} from '@shared/layers'
import { hasSpeedRamp, videoSpeedAtSource } from '@shared/speed'
import { applyLayoutPreset, makeLayoutLayer } from '@shared/layouts'
import type { PresetId } from '@shared/export'
import { extractAudioPieces } from '@/lib/timeline'
// Namespaced: the group ops keep the same names as the actions that expose them.
import * as links from '@/lib/links'
import { replaceAt, updateById } from '@/lib/arrays'
import { primaryRef, useUi } from '@/state/ui'
import { usePlayback } from '@/state/playback'
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

/** A partial patch over a layer's content (the caller guards the content kind).
 *  A union of partials rather than Record<string, unknown> so a typo'd field
 *  name fails typecheck instead of silently landing in the saved document. */
type ContentPatch = Partial<VideoContent> | Partial<ImageContent> | Partial<TextContent>

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

/** Imperative twin of the `activeComp` selector, for event handlers. */
export const getActiveComp = (): Composition | null => activeComp(useProject.getState())

interface ProjectState {
  project: Project | null
  past: Project[]
  future: Project[]
  loaded: boolean
  /** Path of the bound .reel file, or null if this project was never saved to one. */
  filePath: string | null
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

  load: () => Promise<void>
  newProjectFile: () => void
  openFile: () => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
  setPreset: (preset: PresetId) => void
  addMedia: (ids: string[]) => void
  removeMedia: (id: string) => void
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
  /** Step the editor INTO a nested composition (a compound layer, or a layout
   *  cell that carries a comp). No-ops if the step doesn't resolve or the
   *  depth cap is hit. Clears selection and rewinds the playhead. */
  enterComposition: (step: CompStep) => void
  /** Step back out one level (to the parent composition). */
  exitComposition: () => void
  /** Flush a pending debounced autosave immediately (window unload can land
   *  inside the 400ms debounce window and lose the last edit). */
  flushSave: () => void

  // --- Layers ---
  /** Append a layer to the FRONT of the stack (top). */
  addLayer: (layer: Layer) => void
  /** Add a video layer (front) at `startSec`; optionally extract its audio. */
  addVideoLayer: (id: string, mediaId: string, startSec: number, durationSec: number, hasAudio?: boolean) => void
  /** Add an empty multi-clip layout layer (front) at `startSec`. */
  addLayoutLayer: (id: string, presetId: string, startSec: number) => void
  /** Re-shape a layout to another preset (cells keep media/trim by index). */
  setLayoutPreset: (id: string, presetId: string) => void
  /** Patch one cell of a layout layer (media / trim / mute). */
  updateLayoutCell: (id: string, cellIndex: number, patch: Partial<LayoutCell>) => void
  /** Convert a layout cell into a nested composition ("edit this panel"),
   *  seeded from the cell's clip (empty cell → empty comp). No-op when the
   *  cell already carries a comp or the depth cap would be exceeded. The
   *  caller then typically `enterComposition({ layerId, cellIndex })`. */
  convertCellToComp: (layerId: string, cellIndex: number) => void
  /** Convert a timeline LAYER into a compound clip: the layer moves into a new
   *  nested composition (zero-based) and is replaced in place by a compound
   *  layer spanning the same window. No-op past the depth cap, on a layer that
   *  is already a compound, or on a linked tile (the group would be split). */
  convertLayerToComp: (layerId: string) => void
  updateLayer: (id: string, patch: Partial<Layer>) => void
  updateLayerContent: (id: string, patch: ContentPatch) => void
  removeLayer: (id: string) => void
  toggleLayerHidden: (id: string) => void
  /** Reapply a new front→back order of the *visible* layers to the full stack. */
  reorderLayers: (visibleFrontToBack: string[]) => void
  /** Split one layer (video / text / image) at an absolute timeline time. */
  splitLayerAt: (id: string, atSec: number) => void

  // --- Link groups (tiles that move / split / delete as one; lib/links.ts) ---
  /** Link every (linkable) tile in `refs` into one group, merging the groups
   *  they already belong to. Layout layers are never linked. */
  linkItems: (refs: TimelineItemRef[]) => void
  /** Break every link group represented in `refs`, member tiles included. */
  unlinkItems: (refs: TimelineItemRef[]) => void
  /** Delete every tile in `refs` (any lane) as one undo step. */
  removeItems: (refs: TimelineItemRef[]) => void
  /** Shift every tile in `refs` by `delta` seconds as one undo step, preserving
   *  their relative offsets and durations (the timeline drag applies the same
   *  helper live, then commits once). */
  moveItemsBy: (refs: TimelineItemRef[], delta: number) => void
  /**
   * Split every tile in `refs` that the playhead at `atSec` crosses — tiles it
   * misses are left whole. `srcDur` resolves an audio source's duration (only
   * whole-source clips need it). The right-hand halves become their own group.
   */
  splitItemsAt: (refs: TimelineItemRef[], atSec: number, srcDur: links.SourceDuration) => void
  /** Pull a video layer's audio onto the audio track and mute the layer. */
  extractLayerAudio: (id: string) => void
  /** Set a video layer's constant playback speed, recomputing its timeline end
   *  from the shared duration invariant (source span / speed + holds). */
  setVideoSpeed: (id: string, speed: number) => void
  /** Add (or update) a speed-ramp keyframe at the SOURCE time under timeline
   *  time `atSec`, seeded with the profile's current speed there. Recomputes
   *  the layer end from the shared duration invariant. */
  addSpeedKeyframe: (id: string, atSec: number) => void
  /** Change the speed of the ramp keyframe at `index` (in sorted order). */
  updateSpeedKeyframe: (id: string, index: number, speed: number) => void
  /** Remove the ramp keyframe at `index` (in sorted order). */
  removeSpeedKeyframe: (id: string, index: number) => void
  /** Drop the whole ramp; the clip returns to its constant `speed`. */
  clearSpeedRamp: (id: string) => void
  /** Capture the layer's effective transform at timeline time `atSec` as a
   *  keyframe (upserting one already at that offset). Video/image layers only. */
  addLayerKeyframe: (id: string, atSec: number) => void
  /** Remove the keyframe at `index` (in sorted order). */
  removeLayerKeyframe: (id: string, index: number) => void
  /** Set the opacity (0..1) of the keyframe at `index` (in sorted order). */
  setLayerKeyframeOpacity: (id: string, index: number, opacity: number) => void
  /** Drop all keyframes; the layer returns to its static base transform. */
  clearLayerKeyframes: (id: string) => void
  /** Add a freeze hold at source time `atSrcSec`, extending the layer by `holdSec`. */
  addFreeze: (id: string, atSrcSec: number, holdSec: number) => void
  /** Remove the freeze at `index`, shrinking the layer by its hold. */
  removeFreeze: (id: string, index: number) => void

  // --- Captions / script / audio (unchanged tracks) ---
  setCaptions: (captions: CaptionsConfig) => void
  addScriptLine: (atSec: number | null) => void
  updateScriptLine: (id: string, patch: Partial<ScriptLine>) => void
  removeScriptLine: (id: string) => void
  updateCaption: (id: string, patch: Partial<import('@shared/project').CaptionSegment>) => void
  removeCaption: (id: string) => void
  /** Patch the lane-wide caption style (applies to every non-overridden segment). */
  setCaptionStyle: (patch: Partial<import('@shared/project').CaptionStyle>) => void
  /** Patch one segment's style override (seeded from the effective style), exempting
   *  it from the lane-wide style. */
  setCaptionSegmentStyle: (id: string, patch: Partial<import('@shared/project').CaptionStyle>) => void
  /** Drop a segment's override so it follows the lane-wide style again. */
  clearCaptionSegmentStyle: (id: string) => void
  addAudioClip: (clip: AudioClip) => void
  updateAudioClip: (id: string, patch: Partial<AudioClip>) => void
  removeAudioClip: (id: string) => void
  /** Set the project-wide noise-filter default (per-clip overrides still win). */
  setDenoiseDefault: (on: boolean) => void
  /** Set the project-wide stabilization default (per-clip overrides still win). */
  setStabilizeDefault: (stab: import('@shared/project').Stabilize | null) => void
  splitAudioOnSilence: (audioId: string, ranges: { start: number; end: number }[]) => void
  splitAudioAt: (audioId: string, atSec: number, sourceDurationSec: number) => void

  undo: () => void
  redo: () => void
}

export const useProject = create<ProjectState>((set, get) => {
  function markDirty(): void {
    if (!get().dirty) set({ dirty: true })
    saveSession(get().filePath, true)
  }

  /** Apply a pure ROOT-document transform, recording undo history and
   *  autosaving. Root-only actions (preset, media list, script, project-wide
   *  defaults) use this directly; timeline edits go through `commitComp`. */
  function commit(transform: (p: Project) => Project): void {
    const current = get().project
    if (!current) return
    // Editing inside a compound changes how long it plays, so its parent block
    // has to follow (v1 comps are untrimmed — the window IS the duration).
    // A no-op sync returns the same object, so this can't churn history.
    const next = syncCompoundWindows(transform(current)) as Project
    if (next === current) return
    set({ project: next, past: [...get().past, current].slice(-HISTORY_LIMIT), future: [] })
    scheduleSave(next)
    markDirty()
  }

  /** Apply a pure transform to the ACTIVE composition (the root when
   *  `editPath` is empty — then `transform` receives the project itself, so
   *  behavior is byte-identical to `commit`). THE indirection that lets every
   *  timeline action edit root and nested docs with one implementation. */
  function commitComp(transform: (c: Composition) => Composition): void {
    commit((p) => updateCompAtPath(p, get().editPath, transform))
  }

  /** Switch to a different project document, resetting history and selection. */
  function adopt(project: Project, filePath: string | null): void {
    useUi.getState().clearSelection()
    set({ project, past: [], future: [], filePath, dirty: false, editPath: [] })
    saveSession(filePath, false)
    scheduleSave(project)
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

  const mapLayer = (c: Composition, id: string, fn: (l: Layer) => Layer): Composition => ({
    ...c,
    layers: updateById(c.layers, id, fn)
  })

  return {
    project: null,
    past: [],
    future: [],
    loaded: false,
    filePath: null,
    dirty: false,
    editPath: [],

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
      set({ project: res.project, filePath: res.path, dirty: false })
      saveSession(res.path, false)
      scheduleSave(res.project)
    },

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
      set({ project: updateCompAtPath(current, get().editPath, transform) })
    },

    liveUpdateRoot: (transform) => {
      const current = get().project
      if (!current) return
      set({ project: transform(current) })
    },

    enterComposition: (step) => {
      const { project, editPath } = get()
      if (!project) return
      const path = [...editPath, step]
      // The step must resolve, and the target must sit within the depth cap
      // (root = depth 1, so a path of length L edits at depth L + 1).
      if (path.length + 1 > MAX_COMP_DEPTH || !resolveCompAtPath(project, path)) return
      useUi.getState().clearSelection()
      usePlayback.getState().setPlaying(false)
      usePlayback.getState().setTime(0)
      set({ editPath: path })
    },

    exitComposition: () => {
      const { editPath } = get()
      if (editPath.length === 0) return
      useUi.getState().clearSelection()
      usePlayback.getState().setPlaying(false)
      usePlayback.getState().setTime(0)
      set({ editPath: editPath.slice(0, -1) })
    },

    commitLive: (before) => {
      const current = get().project
      if (!current || current === before) return
      set({ past: [...get().past, before].slice(-HISTORY_LIMIT), future: [] })
      scheduleSave(current)
      markDirty()
    },

    flushSave: () => {
      if (!saveTimer) return
      clearTimeout(saveTimer)
      saveTimer = null
      const p = get().project
      // Fire-and-forget: the invoke reaches the main process before the window
      // tears down, and main outlives the renderer to finish the write.
      if (p) void saveProject(p)
    },

    // --- Layers ---
    addLayer: (layer) => commitComp((p) => ({ ...p, layers: [...p.layers, layer] })),

    addVideoLayer: (id, mediaId, startSec, durationSec, hasAudio = false) =>
      commitComp((p) => {
        // A clip and the audio track pulled off it are ONE thing by default, so
        // the pair lands LINKED: move/trim/split/delete either and the other
        // follows (`lib/links.ts`). Unlink from the timeline bar to edit one.
        const linkGroupId = hasAudio ? newId() : undefined
        const base = makeVideoLayer(id, mediaId, startSec, durationSec, { mute: hasAudio })
        const layer = linkGroupId ? { ...base, linkGroupId } : base
        const audioClips = hasAudio
          ? [
              ...p.audioClips,
              {
                id: newId(),
                mediaId,
                startSec,
                inSec: 0,
                outSec: Math.max(0.1, durationSec),
                gainDb: 0,
                fadeInSec: 0,
                fadeOutSec: 0,
                duck: false,
                linkGroupId,
                kind: 'extracted' as const
              }
            ]
          : p.audioClips
        return { ...p, layers: [...p.layers, layer], audioClips }
      }),

    addLayoutLayer: (id, presetId, startSec) =>
      commitComp((p) => ({ ...p, layers: [...p.layers, makeLayoutLayer(id, presetId, startSec)] })),

    setLayoutPreset: (id, presetId) =>
      commitComp((p) =>
        mapLayer(p, id, (l) =>
          l.content.kind === 'layout'
            ? { ...l, content: applyLayoutPreset(l.content, presetId) }
            : l
        )
      ),

    updateLayoutCell: (id, cellIndex, patch) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'layout') return l
          const cells = l.content.cells.map((cell, i) => (i === cellIndex ? { ...cell, ...patch } : cell))
          return { ...l, content: { ...l.content, cells } }
        })
      ),

    convertCellToComp: (layerId, cellIndex) => {
      // Depth check against where the comp will LIVE (one below the active
      // comp): active depth = editPath.length + 1; the new comp sits one deeper.
      if (get().editPath.length + 2 > MAX_COMP_DEPTH) return
      commitComp((p) =>
        mapLayer(p, layerId, (l) => {
          if (l.content.kind !== 'layout') return l
          const cell = l.content.cells[cellIndex]
          if (!cell || cell.comp) return l
          const comp = makeCompFromCell(cell, newId)
          if (compDepth(comp) + get().editPath.length + 1 > MAX_COMP_DEPTH) return l
          const cells = l.content.cells.map((c, i) =>
            // The comp now owns the content; the single-clip fields stay behind
            // only as the seed's provenance (comp overrides them everywhere).
            // The cell-level mute OPENS: cells default to muted (four panels
            // shouting at once is chaos), but a comp mixes its own audio — per
            // clip and on its own lane — so leaving it shut would be a second,
            // invisible gate over those choices. The seeded clip keeps the old
            // mute, so converting alone changes nothing you can hear.
            i === cellIndex ? { ...c, comp, mediaId: null, mute: false } : c
          )
          return { ...l, content: { ...l.content, cells } }
        })
      )
    },

    convertLayerToComp: (layerId) => {
      if (get().editPath.length + 2 > MAX_COMP_DEPTH) return
      commitComp((p) =>
        mapLayer(p, layerId, (l) => {
          if (l.content.kind === 'compound') return l
          // A linked tile moves with partners that would stay behind.
          if (l.linkGroupId && links.isLinked(p, { kind: 'layer', id: layerId })) return l
          const comp = makeCompFromLayer(l)
          if (compDepth(comp) + get().editPath.length + 1 > MAX_COMP_DEPTH) return l
          // Same window and stack slot; the transform resets because the comp
          // renders as a full frame (its inner layer keeps the old transform).
          return {
            id: l.id,
            hidden: l.hidden,
            startSec: l.startSec,
            endSec: l.endSec,
            x: FRAME.width / 2,
            y: FRAME.height / 2,
            scale: 1,
            content: { kind: 'compound', comp }
          }
        })
      )
    },

    updateLayer: (id, patch) => commitComp((p) => mapLayer(p, id, (l) => ({ ...l, ...patch }))),

    updateLayerContent: (id, patch) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => ({ ...l, content: { ...l.content, ...patch } as Layer['content'] }))
      ),

    removeLayer: (id) => {
      commitComp((p) => links.removeItems(p, [{ kind: 'layer', id }]))
      if (useUi.getState().selectedLayerId === id) useUi.getState().selectLayer(null)
    },

    toggleLayerHidden: (id) => commitComp((p) => mapLayer(p, id, (l) => ({ ...l, hidden: !l.hidden }))),

    reorderLayers: (visibleFrontToBack) =>
      commitComp((p) => ({ ...p, layers: applyVisibleOrder(p.layers, [...visibleFrontToBack].reverse()) })),

    // Both single-tile splits go through the group path so there is exactly one
    // split implementation (a lone tile is just a group of one).
    splitLayerAt: (id, atSec) => get().splitItemsAt([{ kind: 'layer', id }], atSec, () => 0),

    linkItems: (refs) => commitComp((p) => links.linkItems(p, refs, newId)),

    unlinkItems: (refs) => commitComp((p) => links.unlinkItems(p, refs)),

    removeItems: (refs) => {
      commitComp((p) => links.removeItems(p, refs))
      useUi.getState().clearSelection() // everything selected is gone
    },

    moveItemsBy: (refs, delta) => commitComp((p) => links.moveItemsBy(p, refs, delta)),

    splitItemsAt: (refs, atSec, srcDur) => {
      commitComp((p) => links.splitItemsAt(p, refs, atSec, srcDur, newId))
      // A split re-groups the two sides, so the selection has to re-resolve
      // around the tile the user actually clicked (its left half keeps its id)
      // — against the ACTIVE composition, where the tiles live.
      const root = get().project
      const comp = root ? resolveCompAtPath(root, get().editPath) : null
      const ui = useUi.getState()
      const primary = primaryRef(ui)
      if (comp && primary && links.tileOf(comp, primary)) {
        ui.selectItems(links.expandGroup(comp, primary), primary)
      }
    },

    setVideoSpeed: (id, speed) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video') return l
          const content = { ...l.content, speed: speed === 1 ? undefined : speed }
          return { ...l, endSec: l.startSec + playedVideoDuration(content), content }
        })
      ),

    addSpeedKeyframe: (id, atSec) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video') return l
          const c = l.content
          // Anchor at the SOURCE time under the playhead, seeded with the
          // profile's current speed there — inserting a point on a linear
          // segment leaves the profile (and so the duration) unchanged until
          // the user edits its speed.
          const src = videoSourceTime(c, l, atSec)
          const speed = videoSpeedAtSource(c, src)
          const kept = (c.speedRamp ?? []).filter((k) => Math.abs(k.atSec - src) > 0.02)
          const speedRamp = [...kept, { atSec: src, speed }].sort((a, b) => a.atSec - b.atSec)
          const content = { ...c, speedRamp }
          return { ...l, endSec: l.startSec + playedVideoDuration(content), content }
        })
      ),

    updateSpeedKeyframe: (id, index, speed) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video') return l
          const c = l.content
          const kfs = [...(c.speedRamp ?? [])].sort((a, b) => a.atSec - b.atSec)
          if (!kfs[index]) return l
          kfs[index] = { ...kfs[index], speed }
          const content = { ...c, speedRamp: kfs }
          return { ...l, endSec: l.startSec + playedVideoDuration(content), content }
        })
      ),

    removeSpeedKeyframe: (id, index) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video') return l
          const c = l.content
          const kfs = [...(c.speedRamp ?? [])].sort((a, b) => a.atSec - b.atSec)
          if (!kfs[index]) return l
          const next = kfs.filter((_, i) => i !== index)
          const content = { ...c, speedRamp: next.length ? next : undefined }
          return { ...l, endSec: l.startSec + playedVideoDuration(content), content }
        })
      ),

    clearSpeedRamp: (id) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video' || !hasSpeedRamp(l.content)) return l
          const content = { ...l.content, speedRamp: undefined }
          return { ...l, endSec: l.startSec + playedVideoDuration(content), content }
        })
      ),

    addLayerKeyframe: (id, atSec) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          // Text animates via its own presets; layouts have no export keyframe path.
          if (l.content.kind === 'text' || l.content.kind === 'layout') return l
          const tSec = Math.max(0, Math.min(atSec - l.startSec, Math.max(0, l.endSec - l.startSec)))
          // Full opacity is stored as ABSENCE so untouched keyframes keep the
          // plain (opaque) pipeline on export.
          const { opacity, ...tr } = layerTransformAt(l, atSec)
          return {
            ...l,
            keyframes: upsertKeyframe(l.keyframes, {
              tSec,
              ...tr,
              ...(opacity < 0.9995 ? { opacity } : {})
            })
          }
        })
      ),

    removeLayerKeyframe: (id, index) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          const kfs = [...(l.keyframes ?? [])].sort((a, b) => a.tSec - b.tSec)
          if (!kfs[index]) return l
          const next = kfs.filter((_, i) => i !== index)
          return { ...l, keyframes: next.length ? next : undefined }
        })
      ),

    setLayerKeyframeOpacity: (id, index, opacity) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          const kfs = [...(l.keyframes ?? [])].sort((a, b) => a.tSec - b.tSec)
          if (!kfs[index]) return l
          const o = Math.min(1, Math.max(0, opacity))
          // Store 1 as absence so untouched keyframes keep the plain pipeline.
          kfs[index] = { ...kfs[index], opacity: o >= 0.9995 ? undefined : o }
          return { ...l, keyframes: kfs }
        })
      ),

    clearLayerKeyframes: (id) =>
      commitComp((p) => mapLayer(p, id, (l) => ({ ...l, keyframes: undefined }))),

    extractLayerAudio: (id) =>
      commitComp((p) => {
        const layer = p.layers.find((l) => l.id === id)
        if (!layer || layer.content.kind !== 'video') return p
        // A re-timed clip's audio can't be detached to the (1×) audio lane —
        // the AudioClip model has no tempo. The Inspector disables the action.
        if (videoSpeed(layer.content) !== 1 || hasSpeedRamp(layer.content)) return p
        const c = layer.content
        // Freeze holds split the audio into pieces with silent gaps so the dialogue
        // cuts while a frame is held (and stays synced to the stretched video).
        const pieces = extractAudioPieces(layer, c, newId)
        return {
          ...mapLayer(p, id, (l) => ({ ...l, content: { ...c, mute: true } })),
          audioClips: [...p.audioClips, ...pieces]
        }
      }),

    addFreeze: (id, atSrcSec, holdSec) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video' || holdSec <= 0) return l
          const c = l.content
          const at = Math.min(c.outSec, Math.max(c.inSec, atSrcSec))
          const freezes = [...(c.freezes ?? []), { atSec: at, holdSec }].sort((a, b) => a.atSec - b.atSec)
          return { ...l, endSec: l.endSec + holdSec, content: { ...c, freezes } }
        })
      ),

    removeFreeze: (id, index) =>
      commitComp((p) =>
        mapLayer(p, id, (l) => {
          if (l.content.kind !== 'video') return l
          const c = l.content
          const freezes = c.freezes ?? []
          const f = freezes[index]
          if (!f) return l
          const next = freezes.filter((_, i) => i !== index)
          return {
            ...l,
            endSec: Math.max(l.startSec + 0.2, l.endSec - f.holdSec),
            content: { ...c, freezes: next.length ? next : undefined }
          }
        })
      ),

    // --- Captions / script / audio ---
    setCaptions: (captions) => commitComp((p) => ({ ...p, captions })),

    addScriptLine: (atSec) =>
      commit((p) => ({ ...p, script: [...p.script, { id: newId(), text: '', atSec }] })),

    updateScriptLine: (id, patch) =>
      commit((p) => ({ ...p, script: updateById(p.script, id, (l) => ({ ...l, ...patch })) })),

    removeScriptLine: (id) => commit((p) => ({ ...p, script: p.script.filter((l) => l.id !== id) })),

    updateCaption: (id, patch) =>
      commitComp((p) => ({
        ...p,
        captions: { ...p.captions, segments: updateById(p.captions.segments, id, (s) => ({ ...s, ...patch })) }
      })),

    removeCaption: (id) => commitComp((p) => links.removeItems(p, [{ kind: 'caption', id }])),

    setCaptionStyle: (patch) =>
      commitComp((p) => ({ ...p, captions: { ...p.captions, style: { ...p.captions.style, ...patch } } })),

    setCaptionSegmentStyle: (id, patch) =>
      commitComp((p) => ({
        ...p,
        captions: {
          ...p.captions,
          segments: updateById(p.captions.segments, id, (s) => ({
            ...s,
            style: { ...(s.style ?? p.captions.style), ...patch }
          }))
        }
      })),

    clearCaptionSegmentStyle: (id) =>
      commitComp((p) => ({
        ...p,
        captions: {
          ...p.captions,
          segments: updateById(p.captions.segments, id, (s) => ({ ...s, style: null }))
        }
      })),

    addAudioClip: (clip) => commitComp((p) => ({ ...p, audioClips: [...p.audioClips, clip] })),

    updateAudioClip: (id, patch) =>
      commitComp((p) => ({ ...p, audioClips: updateById(p.audioClips, id, (a) => ({ ...a, ...patch })) })),

    removeAudioClip: (id) => commitComp((p) => links.removeItems(p, [{ kind: 'audio', id }])),

    setDenoiseDefault: (on) => commit((p) => (p.denoiseDefault === on ? p : { ...p, denoiseDefault: on })),

    setStabilizeDefault: (stab) => commit((p) => ({ ...p, stabilizeDefault: stab })),

    splitAudioOnSilence: (audioId, ranges) =>
      commitComp((p) => {
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
        return { ...p, audioClips: replaceAt(p.audioClips, idx, 1, ...pieces) }
      }),

    splitAudioAt: (audioId, atSec, sourceDurationSec) =>
      get().splitItemsAt([{ kind: 'audio', id: audioId }], atSec, () => sourceDurationSec),

    undo: () => {
      const { past, project, future } = get()
      if (!project || past.length === 0) return
      const prev = past[past.length - 1]
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future] })
      revalidateEditPath(prev)
      scheduleSave(prev)
      markDirty()
    },

    redo: () => {
      const { future, project, past } = get()
      if (!project || future.length === 0) return
      const next = future[0]
      set({ project: next, future: future.slice(1), past: [...past, project] })
      revalidateEditPath(next)
      scheduleSave(next)
      markDirty()
    }
  }
})
