/**
 * Brand color palette (persisted in settings.json). Loaded once, mutated
 * through `add`/`remove`, and written back via the settings IPC. Surfaced as a
 * swatch strip in the text/caption style controls for one-tap color apply.
 */

import { create } from 'zustand'
import { DEFAULT_BRAND_COLORS } from '@shared/settings'
import { getSettings, updateSettings } from '@/ipc/client'

interface BrandColorsState {
  colors: string[]
  loaded: boolean
  load: () => Promise<void>
  add: (hex: string) => void
  remove: (hex: string) => void
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export const useBrandColors = create<BrandColorsState>((set, get) => ({
  colors: DEFAULT_BRAND_COLORS,
  loaded: false,
  load: async () => {
    if (get().loaded) return
    set({ loaded: true })
    try {
      const s = await getSettings()
      if (Array.isArray(s.brandColors) && s.brandColors.length) set({ colors: s.brandColors })
    } catch {
      /* keep defaults */
    }
  },
  add: (hex) => {
    if (get().colors.some((c) => eq(c, hex))) return
    const colors = [...get().colors, hex]
    set({ colors })
    void updateSettings({ brandColors: colors })
  },
  remove: (hex) => {
    const colors = get().colors.filter((c) => !eq(c, hex))
    set({ colors })
    void updateSettings({ brandColors: colors })
  }
}))
