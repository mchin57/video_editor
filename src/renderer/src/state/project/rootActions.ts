/** Project store slice: ROOT-document settings — the output format, the media
 *  list, project-wide defaults and the script. These always edit the root,
 *  even while the editor is inside a nested composition. */

import type { PresetId } from '@shared/formats'
import type { ScriptLine, Stabilize } from '@shared/project'
import { resetMediaCuts } from '@shared/compositions'
import { newId } from '@shared/ids'
import { updateById } from '@/lib/arrays'
import type { Doc } from './core'

export interface RootActions {
  setPreset: (preset: PresetId) => void
  /** A relink pointed `mediaId` at a file of a different length: every
   *  placement (nested comps too) resets to the whole new file. One undo step. */
  resetMediaCuts: (mediaId: string, durationSec: number) => void
  addMedia: (ids: string[]) => void
  removeMedia: (id: string) => void
  /** Set the project-wide noise-filter default (per-clip overrides still win). */
  setDenoiseDefault: (on: boolean) => void
  /** Set the project-wide stabilization default (per-clip overrides still win). */
  setStabilizeDefault: (stab: Stabilize | null) => void
  addScriptLine: (atSec: number | null) => void
  updateScriptLine: (id: string, patch: Partial<ScriptLine>) => void
  removeScriptLine: (id: string) => void
}

export const rootActions = ({ commit }: Doc): RootActions => ({
  setPreset: (preset) => commit((p) => ({ ...p, preset })),

  resetMediaCuts: (mediaId, durationSec) => commit((p) => resetMediaCuts(p, mediaId, durationSec)),

  addMedia: (ids) =>
    commit((p) => {
      const add = ids.filter((id) => !p.mediaIds.includes(id))
      return add.length ? { ...p, mediaIds: [...p.mediaIds, ...add] } : p
    }),

  removeMedia: (id) =>
    commit((p) => (p.mediaIds.includes(id) ? { ...p, mediaIds: p.mediaIds.filter((m) => m !== id) } : p)),

  setDenoiseDefault: (on) => commit((p) => (p.denoiseDefault === on ? p : { ...p, denoiseDefault: on })),

  setStabilizeDefault: (stab) => commit((p) => ({ ...p, stabilizeDefault: stab })),

  addScriptLine: (atSec) => commit((p) => ({ ...p, script: [...p.script, { id: newId(), text: '', atSec }] })),

  updateScriptLine: (id, patch) =>
    commit((p) => ({ ...p, script: updateById(p.script, id, (l) => ({ ...l, ...patch })) })),

  removeScriptLine: (id) => commit((p) => ({ ...p, script: p.script.filter((l) => l.id !== id) }))
})
