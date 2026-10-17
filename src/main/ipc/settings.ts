/** IPC: settings, the assistant's status, and what the system can do. */

import { getCapabilities } from '../services/ffmpeg'
import { getDataDir } from '../config'
import { getSettings, updateSettings } from '../services/settings'
import { assistantStatus, startAssistant } from '../assistant/service'
import { dialogsFor, handle, pickedPath } from './handle'

export function registerSettingsHandlers(): void {
  handle('getCapabilities', () => getCapabilities())
  handle('getDataDir', () => getDataDir())

  handle('getSettings', () => getSettings())
  handle('updateSettings', async (_event, patch) => {
    const next = await updateSettings(patch)
    // Toggling the assistant restarts (or stops) the pipe server live.
    if (patch.assistant) await startAssistant()
    return next
  })
  handle('chooseExportDir', async (event) => {
    const dir = pickedPath(
      await dialogsFor(event).open({
        title: 'Choose default export folder',
        properties: ['openDirectory', 'createDirectory']
      })
    )
    return dir ? updateSettings({ exportDir: dir }) : getSettings()
  })

  handle('assistantStatus', () => assistantStatus())
}
