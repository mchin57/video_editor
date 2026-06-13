import { create } from 'zustand'

/** Transient editor UI selection that doesn't belong in the project document. */
interface UiState {
  /** Currently selected text overlay (for editing/dragging). */
  selectedOverlayId: string | null
  selectOverlay: (id: string | null) => void
  /** Whether the crop editor modal is open. */
  cropEditing: boolean
  setCropEditing: (v: boolean) => void
  /** Whether the settings modal is open. */
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  selectedOverlayId: null,
  selectOverlay: (id) => set({ selectedOverlayId: id }),
  cropEditing: false,
  setCropEditing: (v) => set({ cropEditing: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v })
}))
