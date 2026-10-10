/**
 * Renderer half of the assistant bridge: run each op against the REAL store
 * actions (the same calls the UI makes), so undo, links and source-time
 * mapping behave exactly as for a human edit. No React.
 */

import type { AssistantOps, AssistantRequest, AssistantResponse } from '@shared/assistant/protocol'
import type { Composition, Project } from '@shared/project'
import { summarizeTimeline } from '@shared/assistant/timelineSummary'
import { activeComp, useProject } from '@/state/projectStore'
import { expandSelection, timelineTiles } from '@/lib/links'
import { assistantRespond, onAssistantRequest } from '@/ipc/client'

type Handlers = { [K in keyof AssistantOps]: (args: AssistantOps[K]['args']) => AssistantOps[K]['result'] }

function project(): Project {
  const p = useProject.getState().project
  if (!p) throw new Error('Editor has no project open')
  return p
}

function comp(): Composition {
  const c = activeComp(useProject.getState())
  if (!c) throw new Error('Editor has no project open')
  return c
}

const handlers: Handlers = {
  getMediaIds: () => project().mediaIds,
  addMedia: ({ ids }) => {
    // The store's commit() silently no-ops without a project; fail loudly instead.
    project()
    useProject.getState().addMedia(ids)
    return null
  },
  getTimeline: () => summarizeTimeline(comp()),
  placeSequence: (plan) => useProject.getState().addVideoSequence(plan),
  removeItems: ({ ids }) => {
    const c = comp()
    const tiles = timelineTiles(c)
    const unknown = ids.filter((id) => !tiles.some((t) => t.ref.id === id))
    if (unknown.length) throw new Error(`No timeline item with id ${unknown.join(', ')}`)
    const refs = expandSelection(c, tiles.filter((t) => ids.includes(t.ref.id)).map((t) => t.ref))
    useProject.getState().removeItems(refs)
    return { removed: refs }
  },
  undo: () => {
    const before = useProject.getState().past.length
    useProject.getState().undo()
    return { undone: useProject.getState().past.length < before, timeline: summarizeTimeline(comp()) }
  },
  getProject: () => project()
}

export function installAssistantBridge(): () => void {
  return onAssistantRequest((req: AssistantRequest) => {
    // Arrived after main gave up (the renderer was blocked, e.g. by a confirm dialog):
    // running it now would apply an edit nobody is told about. Main has already answered.
    if (Date.now() > req.deadline) {
      console.warn(`[assistant] dropped expired "${req.op}" request`)
      return
    }
    let res: AssistantResponse
    try {
      // The table is keyed by op, so this lookup is type-safe; widen it to call generically.
      const run = handlers[req.op] as unknown as (args: unknown) => unknown
      res = { id: req.id, ok: true, result: run(req.args) }
    } catch (e) {
      res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    assistantRespond(res)
  })
}
