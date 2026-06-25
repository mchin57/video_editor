import { create } from 'zustand'

/** Transient editor UI selection that doesn't belong in the project document. */
interface UiState {
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

export const useUi = create<UiState>((set) => ({
  selectedLayerId: null,
  selectLayer: (id) =>
    set({ selectedLayerId: id, selectedCaptionId: null, selectedAudioId: null, captionsGlobalSelected: false }),
  selectedCaptionId: null,
  selectCaption: (id) =>
    set({ selectedCaptionId: id, selectedLayerId: null, selectedAudioId: null, captionsGlobalSelected: false }),
  selectedAudioId: null,
  selectAudio: (id) =>
    set({ selectedAudioId: id, selectedLayerId: null, selectedCaptionId: null, captionsGlobalSelected: false }),
  captionsGlobalSelected: false,
  selectCaptionsGlobal: () =>
    set({ captionsGlobalSelected: true, selectedLayerId: null, selectedCaptionId: null, selectedAudioId: null }),
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
    set({ selectedLayerId: null, selectedCaptionId: null, selectedAudioId: null, captionsGlobalSelected: false })
}))
