/**
 * THE project store: the open document, its undo history, and every edit. One
 * zustand store, assembled from slices (`state/project/`): the document core
 * (history, gestures, autosave, which composition is being edited) and the
 * actions by area. Every action changes the document through the core's
 * `commit` / `commitComp`, so history, autosave and nested-composition editing
 * behave the same everywhere. Import the store and its selectors from here.
 */

import { create } from 'zustand'
import type { Composition } from '@shared/project'
import type { ExportPreset } from '@shared/formats'
import { activeComp, createDocument, projectFormat, type ProjectState } from './project/core'
import { fileActions } from './project/fileActions'
import { rootActions } from './project/rootActions'
import { layerActions } from './project/layerActions'
import { videoTimingActions } from './project/videoTimingActions'
import { timelineActions } from './project/timelineActions'
import { captionActions } from './project/captionActions'
import { audioActions } from './project/audioActions'

export { activeComp, projectFormat }
export type { ProjectState }

export const useProject = create<ProjectState>((set, get) => {
  const { doc, state } = createDocument(set, get)
  return {
    ...state,
    ...fileActions(doc),
    ...rootActions(doc),
    ...layerActions(doc),
    ...videoTimingActions(doc),
    ...timelineActions(doc),
    ...captionActions(doc),
    ...audioActions(doc)
  }
})

/** Imperative twin of the `activeComp` selector, for event handlers. */
export const getActiveComp = (): Composition | null => activeComp(useProject.getState())

/** Imperative twin of `projectFormat`, for event handlers. */
export const getFormat = (): ExportPreset => projectFormat(useProject.getState())
