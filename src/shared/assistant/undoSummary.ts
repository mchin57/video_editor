/**
 * What one undo step changed, for the assistant's `undo` reply. History is
 * whole-document snapshots with no labels, and imports, trims and splits are
 * undo steps too — so an agent's `undo` can take clips out of the LIBRARY while
 * the timeline it gets back looks unchanged (#16). Diffing the two snapshots
 * says what actually went. Pure.
 */

import type { Project } from '../project'

interface IdDiff {
  /** Present before the undo, gone after it. */
  removed: string[]
  /** Absent before the undo, back after it. */
  restored: string[]
  /** In both, but different. */
  changed: string[]
}

export interface UndoChanges {
  /** Library (project media) ids. */
  library: { removed: string[]; restored: string[] }
  layers: IdDiff
  audioClips: IdDiff
  captionsChanged: boolean
  /** Anything else in the document (format, volume levels, defaults, script, name). */
  otherChanged: boolean
}

function diffById<T extends { id: string }>(before: T[], after: T[]): IdDiff {
  const a = new Map(after.map((x) => [x.id, x]))
  const b = new Map(before.map((x) => [x.id, x]))
  return {
    removed: before.filter((x) => !a.has(x.id)).map((x) => x.id),
    restored: after.filter((x) => !b.has(x.id)).map((x) => x.id),
    changed: before.filter((x) => a.has(x.id) && JSON.stringify(x) !== JSON.stringify(a.get(x.id))).map((x) => x.id)
  }
}

/** `before` is the state the undo stepped back FROM; `after` the one it restored. */
export function undoChanges(before: Project, after: Project): UndoChanges {
  const rest = (p: Project): string => {
    // Everything not reported field by field; updatedAt is bookkeeping, not an edit.
    const { layers: _l, audioClips: _a, captions: _c, mediaIds: _m, updatedAt: _u, ...others } = p
    return JSON.stringify(others)
  }
  return {
    library: {
      removed: before.mediaIds.filter((id) => !after.mediaIds.includes(id)),
      restored: after.mediaIds.filter((id) => !before.mediaIds.includes(id))
    },
    layers: diffById(before.layers, after.layers),
    audioClips: diffById(before.audioClips, after.audioClips),
    captionsChanged: JSON.stringify(before.captions) !== JSON.stringify(after.captions),
    otherChanged: rest(before) !== rest(after)
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** One sentence naming every kind of change, library first (the easy one to miss). */
export function describeUndo(c: UndoChanges, fileName: (mediaId: string) => string): string {
  const parts: string[] = []
  const names = (ids: string[]): string => ids.map(fileName).join(', ')
  if (c.library.removed.length)
    parts.push(`removed ${plural(c.library.removed.length, 'clip')} from the library (${names(c.library.removed)})`)
  if (c.library.restored.length)
    parts.push(`put ${plural(c.library.restored.length, 'clip')} back in the library (${names(c.library.restored)})`)
  for (const [d, noun] of [
    [c.layers, 'layer'],
    [c.audioClips, 'audio clip']
  ] as const) {
    if (d.removed.length) parts.push(`removed ${plural(d.removed.length, noun)} from the timeline`)
    if (d.restored.length) parts.push(`restored ${plural(d.restored.length, noun)} on the timeline`)
    if (d.changed.length) parts.push(`reverted changes to ${plural(d.changed.length, noun)}`)
  }
  if (c.captionsChanged) parts.push('reverted the captions')
  if (c.otherChanged) parts.push('reverted project settings')
  return parts.length ? `Undid: ${parts.join('; ')}.` : 'Undid a step that changed nothing visible.'
}
