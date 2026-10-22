/**
 * Renderer half of the assistant bridge: run each op against the REAL store
 * actions (the same calls the UI makes), so undo, links and source-time
 * mapping behave exactly as for a human edit. No React.
 */

import type { AssistantOps, AssistantRequest, AssistantResponse } from '@shared/assistant/protocol'
import type { Composition, Project, TimelineItemRef } from '@shared/project'
import { summarizeTimeline } from '@shared/assistant/timelineSummary'
import { summarizeText } from '@shared/assistant/onScreenText'
import { undoChanges } from '@shared/assistant/undoSummary'
import { compositionDuration } from '@shared/compositions'
import { activeComp, useProject } from '@/state/projectStore'
import { usePlayback } from '@/state/playback'
import { primaryRef, useUi } from '@/state/ui'
import {
  canLinkItems,
  expandGroup,
  expandSelection,
  isLinked,
  refKey,
  refsForIds,
  tileOf,
  timelineTiles
} from '@/lib/links'
import { assistantRespond, onAssistantRequest } from '@/ipc/client'
import { interactionOpen, whenIdle } from '@/lib/interaction'
import { exportSaveSkipReason } from '@/lib/exportSave'
import { createLogger } from '@shared/log'

const log = createLogger('assistant')

type Handlers = {
  [K in keyof AssistantOps]: (
    args: AssistantOps[K]['args']
  ) => AssistantOps[K]['result'] | Promise<AssistantOps[K]['result']>
}

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

/** The tiles `ids` name in the open composition, or an error naming the unknown ones. */
function tilesNamed(c: Composition, ids: string[]): TimelineItemRef[] {
  const { refs, unknown } = refsForIds(c, ids)
  if (unknown.length) throw new Error(`No timeline item with id ${unknown.join(', ')}`)
  return refs
}

/** After a link, grow the user's selection to whole groups, so a tile selected on
 *  its own can't then be dragged or deleted away from its new partners. */
function selectWholeGroups(): void {
  const ui = useUi.getState()
  const primary = primaryRef(ui)
  if (!primary) return
  const whole = expandSelection(comp(), ui.selection)
  if (whole.length !== ui.selection.length) ui.selectItems(whole, primary)
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
    const refs = expandSelection(c, tilesNamed(c, ids))
    useProject.getState().removeItems(refs)
    return { removed: refs }
  },
  linkItems: ({ ids }) => {
    const c = comp()
    const refs = tilesNamed(c, ids)
    const linkable = new Set(
      timelineTiles(c)
        .filter((t) => t.linkable)
        .map((t) => refKey(t.ref))
    )
    const targets = refs.filter((r) => linkable.has(refKey(r)))
    const notLinkable = refs.filter((r) => !linkable.has(refKey(r))).map((r) => r.id)
    if (targets.length < 2) {
      const layouts = notLinkable.length ? ` (${notLinkable.join(', ')}: a layout cannot be linked)` : ''
      throw new Error(`Link needs at least two items that can be linked${layouts}`)
    }
    const changed = canLinkItems(c, refs)
    if (changed) {
      useProject.getState().linkItems(refs)
      selectWholeGroups()
    }
    const after = comp()
    return {
      linked: expandGroup(after, targets[0]),
      linkGroupId: tileOf(after, targets[0])?.linkGroupId ?? '',
      changed,
      ...(notLinkable.length ? { notLinkable } : {})
    }
  },
  unlinkItems: ({ ids }) => {
    const c = comp()
    const refs = tilesNamed(c, ids)
    const unlinked = expandSelection(c, refs).filter((r) => isLinked(c, r))
    if (unlinked.length) useProject.getState().unlinkItems(refs)
    return { unlinked }
  },
  undo: () => {
    const before = useProject.getState().past.length
    const from = project()
    useProject.getState().undo()
    const undone = useProject.getState().past.length < before
    return { undone, changes: undone ? undoChanges(from, project()) : null, timeline: summarizeTimeline(comp()) }
  },
  getProject: () => project(),
  saveProject: async ({ projectId }) => {
    // Checked and saved with no await between: the project can't change in between.
    const reason = exportSaveSkipReason({ id: projectId }, useProject.getState())
    if (reason) return { saved: false, reason }
    if (!useProject.getState().filePath) throw new Error('The project has no save file')
    await useProject.getState().save()
    return { saved: true }
  },
  getRenderTarget: () => ({ project: project(), editPath: useProject.getState().editPath }),
  getText: ({ sourceDurations, ...q }) => {
    const c = comp()
    const durationSec = compositionDuration(c, (id) => sourceDurations[id] ?? 0)
    return summarizeText(c, (ref) => isLinked(c, ref), durationSec, q)
  },
  applyTextEdits: ({ edits, sourceDurations }) =>
    useProject.getState().applyTextEdits(edits, (id) => sourceDurations[id] ?? 0),
  setPlayhead: ({ timeSec, sourceDurations }) => {
    const durationSec = compositionDuration(comp(), (id) => sourceDurations[id] ?? 0)
    const t = Math.min(Math.max(0, timeSec), durationSec)
    usePlayback.getState().setPlaying(false)
    usePlayback.getState().setTime(t)
    return { timeSec: t, durationSec }
  }
}

async function answer(req: AssistantRequest): Promise<void> {
  // Arrived (or came off the wait queue) after main gave up — the renderer was blocked
  // by a dialog, or the user held a drag past the deadline: running it now would apply
  // an edit nobody is told about. Main has already answered.
  if (Date.now() > req.deadline) {
    log.warn(`dropped expired "${req.op}" request`)
    return
  }
  let res: AssistantResponse
  try {
    // The table is keyed by op, so this lookup is type-safe; widen it to call generically.
    const run = handlers[req.op] as unknown as (args: unknown) => unknown
    res = { id: req.id, ok: true, result: await run(req.args) }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  assistantRespond(res)
}

export function installAssistantBridge(): () => void {
  // Every op — reads too, so they see the committed result and keep arrival order —
  // waits while the user is mid-drag: a drag recomputes from its pointerdown
  // snapshot, so an edit landing in between would be overwritten (lib/interaction.ts).
  return onAssistantRequest((req: AssistantRequest) => {
    if (interactionOpen()) log.info(`"${req.op}" waits for the user's drag to end`)
    whenIdle(() => void answer(req))
  })
}
