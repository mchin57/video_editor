import { create } from 'zustand'
import type { Composition, TimelineItemRef } from '@shared/project'
import { expandGroup } from '@/lib/links'

/** Transient editor UI selection that doesn't belong in the project document. */
interface UiState {
  /**
   * EVERY selected timeline tile, across lanes — one entry for a plain click,
   * the whole link group when a linked tile is clicked, and any Ctrl/Cmd-built
   * multi-selection. The timeline highlights and moves exactly this set; the
   * three `selected*Id` fields below name the PRIMARY (last clicked) tile, which
   * is what the Inspector and the stage handles edit.
   */
  selection: TimelineItemRef[]
  /** Select a whole set of tiles at once, with `primary` driving the Inspector. */
  selectItems: (refs: TimelineItemRef[], primary: TimelineItemRef) => void
  /**
   * Select ONE tile the way the timeline does — including every tile linked to
   * it, since a link group is never partially selected. Use this anywhere a tile
   * is picked outside the timeline (the stage, the Layers panel). The project is
   * a parameter rather than an import so this store stays free of a cycle with
   * `projectStore`.
   */
  selectTile: (project: Composition | null, ref: TimelineItemRef) => void
  /** Currently selected visual layer (video/image/text) — drives the inspector,
   *  on-canvas handles, and the Layers menu highlight. */
  selectedLayerId: string | null
  selectLayer: (id: string | null) => void
  /** Currently selected caption segment (for editing/dragging). */
  selectedCaptionId: string | null
  selectCaption: (id: string | null) => void
  /** Currently selected audio clip (shows its controls in the Inspector). */
  selectedAudioId: string | null
  selectAudio: (id: string | null) => void
  /** Whether the lane-wide caption style is selected for editing (via the
   *  "Captions" gutter label). Edits apply to every non-overridden caption. */
  captionsGlobalSelected: boolean
  selectCaptionsGlobal: () => void
  /** Whether the crop editor modal is open. */
  cropEditing: boolean
  setCropEditing: (v: boolean) => void
  /** Whether the clip-stills popout is open. */
  stillsOpen: boolean
  setStillsOpen: (v: boolean) => void
  /** Whether the image-edit popout is open. */
  imageEditOpen: boolean
  setImageEditOpen: (v: boolean) => void
  /** Whether the settings modal is open. */
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  /** Whether the checklist modal is open. */
  checklistOpen: boolean
  setChecklistOpen: (v: boolean) => void
  /** Whether the script panel is open. */
  scriptOpen: boolean
  setScriptOpen: (v: boolean) => void
  /** Clear every selection (clip/caption/audio). */
  clearSelection: () => void
}

/** The primary (last clicked) tile as a ref, or null when nothing is selected.
 *  The three `selected*Id` fields are mutually exclusive, so this is total. */
export function primaryRef(s: UiState): TimelineItemRef | null {
  if (s.selectedLayerId) return { kind: 'layer', id: s.selectedLayerId }
  if (s.selectedCaptionId) return { kind: 'caption', id: s.selectedCaptionId }
  if (s.selectedAudioId) return { kind: 'audio', id: s.selectedAudioId }
  return null
}

/** Selecting one tile of a given kind: the primary AND the whole selection.
 *  Keeps the single-selection actions below as thin sugar over `selectItems`. */
const single = (
  kind: TimelineItemRef['kind'],
  id: string | null
): Pick<UiState, 'selection' | 'selectedLayerId' | 'selectedCaptionId' | 'selectedAudioId'> & {
  captionsGlobalSelected: boolean
} => ({
  selection: id ? [{ kind, id }] : [],
  selectedLayerId: kind === 'layer' ? id : null,
  selectedCaptionId: kind === 'caption' ? id : null,
  selectedAudioId: kind === 'audio' ? id : null,
  captionsGlobalSelected: false
})

export const useUi = create<UiState>((set) => ({
  selection: [],
  selectItems: (refs, primary) =>
    set({
      selection: refs,
      selectedLayerId: primary.kind === 'layer' ? primary.id : null,
      selectedCaptionId: primary.kind === 'caption' ? primary.id : null,
      selectedAudioId: primary.kind === 'audio' ? primary.id : null,
      captionsGlobalSelected: false
    }),
  selectTile: (project, ref) => {
    const refs = project ? expandGroup(project, ref) : []
    set({
      selection: refs.length ? refs : [ref],
      selectedLayerId: ref.kind === 'layer' ? ref.id : null,
      selectedCaptionId: ref.kind === 'caption' ? ref.id : null,
      selectedAudioId: ref.kind === 'audio' ? ref.id : null,
      captionsGlobalSelected: false
    })
  },
  selectedLayerId: null,
  selectLayer: (id) => set(single('layer', id)),
  selectedCaptionId: null,
  selectCaption: (id) => set(single('caption', id)),
  selectedAudioId: null,
  selectAudio: (id) => set(single('audio', id)),
  captionsGlobalSelected: false,
  selectCaptionsGlobal: () =>
    set({
      captionsGlobalSelected: true,
      selection: [],
      selectedLayerId: null,
      selectedCaptionId: null,
      selectedAudioId: null
    }),
  cropEditing: false,
  setCropEditing: (v) => set({ cropEditing: v }),
  stillsOpen: false,
  setStillsOpen: (v) => set({ stillsOpen: v }),
  imageEditOpen: false,
  setImageEditOpen: (v) => set({ imageEditOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  checklistOpen: false,
  setChecklistOpen: (v) => set({ checklistOpen: v }),
  scriptOpen: false,
  setScriptOpen: (v) => set({ scriptOpen: v }),
  clearSelection: () =>
    set({
      selection: [],
      selectedLayerId: null,
      selectedCaptionId: null,
      selectedAudioId: null,
      captionsGlobalSelected: false
    })
}))
