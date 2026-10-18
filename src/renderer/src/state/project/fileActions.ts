/** Project store slice: the project FILE — launch, File ▸ New / Open / Save / Save As. */

import {
  createProject as createProjectFolder,
  loadProject,
  openProjectFile,
  saveProjectAs,
  saveProjectFile
} from '@/ipc/client'
import { useUi } from '@/state/ui'
import type { Doc } from './core'

const DISCARD_PROMPT = 'Discard unsaved changes to the current project?'

export interface FileActions {
  load: () => Promise<void>
  /** File ▸ New: after the discard prompt, open the New project window. */
  newProjectFile: () => Promise<void>
  /** The New project window's Create: make `<location>/<name>/` and open it. */
  createProject: (name: string, location: string) => Promise<void>
  /** Main's library changed after open (import, relink, a fixed path): the
   *  project has unsaved changes, and the autosave must carry them. */
  markLibraryChanged: () => void
  openFile: () => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
}

export const fileActions = ({ set, get, adopt, markDirty, scheduleSave, cancelScheduledSave }: Doc): FileActions => ({
  load: async () => {
    const { loaded, message } = await loadProject()
    if (loaded) adopt(loaded.project, loaded.path, loaded.dirty)
    else set({ project: null, filePath: null, dirty: false, launchMessage: message })
    set({ loaded: true })
  },

  // New/Open: main discards the open project's unsaved state (the prompt
  // just confirmed that) and ignores any autosave still in flight for it.
  newProjectFile: async () => {
    if (get().dirty && !window.confirm(DISCARD_PROMPT)) return
    useUi.getState().setNewProjectOpen(true)
  },

  createProject: async (name, location) => {
    cancelScheduledSave()
    const res = await createProjectFolder(name, location)
    adopt(res.project, res.path, res.dirty)
  },

  markLibraryChanged: () => {
    const { project } = get()
    if (!project) return
    scheduleSave(project)
    markDirty()
  },

  openFile: async () => {
    if (get().dirty && !window.confirm(DISCARD_PROMPT)) return
    const res = await openProjectFile()
    if (!res) return
    adopt(res.project, res.path, res.dirty)
  },

  save: async () => {
    const { project, filePath } = get()
    if (!project || !filePath) return
    cancelScheduledSave()
    await saveProjectFile(project)
    // An edit made while the write was in flight is still unsaved (and has
    // scheduled its own autosave).
    if (get().project === project) set({ dirty: false })
  },

  saveAs: async () => {
    const { project } = get()
    if (!project) return
    const hadPending = cancelScheduledSave()
    const res = await saveProjectAs(project)
    if (!res) {
      if (hadPending) scheduleSave(get().project!) // canceled: the dropped autosave still has to happen
      return
    }
    set({ project: res.project, filePath: res.path, dirty: false })
  }
})
