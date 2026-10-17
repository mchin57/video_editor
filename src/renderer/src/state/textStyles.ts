/**
 * Saved text styles (persisted in settings.json, editor-wide — #45). Loaded
 * once, changed through `save`/`remove`, and written back via the settings IPC,
 * like the brand colors. Surfaced as the style picker at the top of the
 * text/caption style controls (`TextStylePicker`).
 */

import { create } from 'zustand'
import type { TextStyleBase } from '@shared/project'
import type { TextAnimation } from '@shared/textAnim'
import { sanitizeTextStyles, upsertTextStyle, type TextStylePreset } from '@shared/textStylePresets'
import { getSettings, updateSettings } from '@/ipc/client'

interface TextStylesState {
  styles: TextStylePreset[]
  loaded: boolean
  load: () => Promise<void>
  /** Save (or overwrite, by name) a style. */
  save: (name: string, style: TextStyleBase, animation?: TextAnimation | null) => void
  remove: (id: string) => void
}

export const useTextStyles = create<TextStylesState>((set, get) => ({
  styles: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return
    set({ loaded: true })
    try {
      const s = await getSettings()
      set({ styles: sanitizeTextStyles(s.textStyles) })
    } catch {
      /* keep none */
    }
  },
  save: (name, style, animation) => {
    const styles = upsertTextStyle(get().styles, name, style, animation, crypto.randomUUID())
    if (styles === get().styles) return
    set({ styles })
    void updateSettings({ textStyles: styles })
  },
  remove: (id) => {
    const styles = get().styles.filter((p) => p.id !== id)
    set({ styles })
    void updateSettings({ textStyles: styles })
  }
}))
