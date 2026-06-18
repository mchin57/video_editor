import { create } from 'zustand'

/** Transient editor UI selection that doesn't belong in the project document. */
interface UiState {
  /** Currently selected text overlay (for editing/dragging). */
  selectedOverlayId: string | null
  selectOverlay: (id: string | null) => void
  /** Currently selected caption segment (for editing/dragging). */
  selectedCaptionId: string | null
  selectCaption: (id: string | null) => void
  /** Currently selected audio clip (shows its controls in the Inspector). */
  selectedAudioId: string | null
  selectAudio: (id: string | null) => void
  /** Currently selected image overlay (for editing/dragging). */
  selectedImageId: string | null
  selectImage: (id: string | null) => void
  /** Whether the crop editor modal is open. */
  cropEditing: boolean
  setCropEditing: (v: boolean) => void
  /** Whether the settings modal is open. */
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  /** Whether the checklist modal is open. */
  checklistOpen: boolean
  setChecklistOpen: (v: boolean) => void
  /** Whether the script panel is open. */
  scriptOpen: boolean
  setScriptOpen: (v: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  selectedOverlayId: null,
  selectOverlay: (id) => set({ selectedOverlayId: id }),
  selectedCaptionId: null,
  selectCaption: (id) => set({ selectedCaptionId: id }),
  selectedAudioId: null,
  selectAudio: (id) => set({ selectedAudioId: id }),
  selectedImageId: null,
  selectImage: (id) => set({ selectedImageId: id }),
  cropEditing: false,
  setCropEditing: (v) => set({ cropEditing: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  checklistOpen: false,
  setChecklistOpen: (v) => set({ checklistOpen: v }),
  scriptOpen: false,
  setScriptOpen: (v) => set({ scriptOpen: v })
}))
