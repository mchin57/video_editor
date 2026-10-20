/**
 * App settings the renderer needs SYNCHRONOUSLY inside store actions (which
 * can't await the settings IPC). Loaded once at startup from settings.json and
 * kept in step when Settings changes them; the persisted copy stays main's.
 *
 * - `autoJoinDefaultLevel`: audio extracted from footage joins the Default
 *   volume level as it lands (`extractedAudioClip`, shared/volumeLevels.ts).
 */

import { create } from 'zustand'
import { withAutoJoinDefault } from '@shared/settings'
import { getSettings, updateSettings } from '@/ipc/client'
import { createLogger } from '@shared/log'

const log = createLogger('settings')

interface AppSettingsState {
  autoJoinDefaultLevel: boolean
  load: () => Promise<void>
  setAutoJoinDefaultLevel: (on: boolean) => Promise<void>
}

export const useAppSettings = create<AppSettingsState>((set) => ({
  autoJoinDefaultLevel: withAutoJoinDefault(undefined),
  load: async () => {
    try {
      const s = await getSettings()
      set({ autoJoinDefaultLevel: withAutoJoinDefault(s.autoJoinDefaultLevel) })
    } catch (error) {
      log.warn('loading the auto-join setting failed; keep the default', error)
    }
  },
  setAutoJoinDefaultLevel: async (on) => {
    set({ autoJoinDefaultLevel: on })
    await updateSettings({ autoJoinDefaultLevel: on })
  }
}))
