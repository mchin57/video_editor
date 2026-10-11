/**
 * Nested compositions (compound clips): the ONE home for locating, updating and
 * measuring the composition tree. A `Composition` is the editable timeline core
 * (`layers` + `audioClips` + `captions` — see `shared/project.ts`); the root
 * `Project` is a Composition, a compound layer carries one, and a layout cell
 * may carry one. Everything that walks this tree — store actions editing the
 * ACTIVE composition, the recursive preview, the recursive export — resolves
 * through these helpers; never traverse `content.comp` / `cell.comp` inline.
 *
 * Nesting is INLINE (a comp owns its children by value), so cycles are
 * impossible by construction; `MAX_COMP_DEPTH` is the only guard needed.
 * V1 semantics: a comp plays from its local t=0, untrimmed — its parent-facing
 * duration IS `compositionDuration`.
 */

import type { Composition, Layer, LayoutCell } from './project'
import { audioClipEnd, createEmptyComposition } from './project'
import { FRAME, layerLabel, playedVideoDuration, visualDuration } from './layers'

/** Maximum nesting depth (root = 1). Deeper enter/convert actions must refuse. */
export const MAX_COMP_DEPTH = 4

/** Resolves a media id to its source duration (seconds); return 0 for unknown —
 *  whole-source audio clips (`outSec <= 0`) then fall back to their `outSec`. */
export type SourceDuration = (mediaId: string) => number

/**
 * One step from a composition to a nested one: into a compound LAYER's comp, or
 * into a layout CELL's comp (`cellIndex` present). A path of steps from the
 * root addresses any composition in the tree; the empty path is the root.
 */
export type CompStep =
  | { layerId: string; cellIndex?: undefined }
  | { layerId: string; cellIndex: number }
export type CompPath = CompStep[]

/** The nested composition one `step` into `comp`, or null if the step doesn't
 *  resolve (no such layer, wrong kind, or a single-clip cell). */
export function stepInto(comp: Composition, step: CompStep): Composition | null {
  const layer = comp.layers.find((l) => l.id === step.layerId)
  if (!layer) return null
  if (step.cellIndex === undefined) {
    return layer.content.kind === 'compound' ? layer.content.comp : null
  }
  if (layer.content.kind !== 'layout') return null
  return layer.content.cells[step.cellIndex]?.comp ?? null
}

/** The composition at `path` from `root`, or null when any step fails. The
 *  empty path resolves to `root` itself (the editor's default). */
export function resolveCompAtPath(root: Composition, path: CompPath): Composition | null {
  let comp: Composition | null = root
  for (const step of path) {
    comp = stepInto(comp, step)
    if (!comp) return null
  }
  return comp
}

/**
 * Immutably apply `fn` to the composition at `path`, returning a new root with
 * every ancestor rebuilt along the way — the bridge that lets the existing
 * root-level `commit`/undo machinery record edits made INSIDE a nested comp.
 * A path that doesn't resolve leaves the document unchanged (callers validate
 * with `resolveCompAtPath`; the no-op keeps a stale path from corrupting data).
 *
 * CONTRACT: `fn` must derive its result by SPREADING its input (`{ ...c, … }`,
 * the codebase-wide convention) or returning it unchanged. At the empty path
 * `fn` is applied to the root document itself (a `Project` IS a Composition),
 * so a spread preserves the root's identity fields and returning the input
 * unchanged preserves reference identity (the store's no-op guard relies on
 * it). Constructing a fresh object from scratch would drop the root's fields.
 */
export function updateCompAtPath<T extends Composition>(
  root: T,
  path: CompPath,
  fn: (comp: Composition) => Composition
): T {
  if (path.length === 0) return fn(root) as T
  const [step, ...rest] = path
  return {
    ...root,
    layers: root.layers.map((l) => {
      if (l.id !== step.layerId) return l
      if (step.cellIndex === undefined && l.content.kind === 'compound') {
        return { ...l, content: { ...l.content, comp: updateCompAtPath(l.content.comp, rest, fn) } }
      }
      if (step.cellIndex !== undefined && l.content.kind === 'layout') {
        return {
          ...l,
          content: {
            ...l.content,
            cells: l.content.cells.map((cell, i) =>
              i === step.cellIndex && cell.comp
                ? { ...cell, comp: updateCompAtPath(cell.comp, rest, fn) }
                : cell
            )
          }
        }
      }
      return l
    })
  }
}

/**
 * Played duration of a composition (seconds): the furthest visual end or audio
 * end. The parent-facing length of a compound layer / comp cell (v1 comps are
 * untrimmed). Mirrors the root duration math in `PreviewStage`.
 */
export function compositionDuration(comp: Composition, srcDur: SourceDuration = () => 0): number {
  const audioEnd = comp.audioClips.reduce(
    (max, a) => Math.max(max, audioClipEnd(a, srcDur(a.mediaId) || a.outSec)),
    0
  )
  return Math.max(visualDuration(comp.layers), audioEnd)
}

/**
 * Re-sync every compound layer's timeline window to its composition's duration,
 * recursively (deepest first, so a change ripples all the way up). V1 comps are
 * untrimmed — the window IS the comp's length — so editing inside a compound
 * has to grow/shrink the block that stands for it, or the parent would clip or
 * pad the result. Returns the input unchanged when nothing moved, so callers
 * can use it on every commit without churning undo history.
 *
 * (Layout CELLS need no equivalent: their span is read from
 * `compositionDuration` at render time rather than stored.)
 */
export function syncCompoundWindows(comp: Composition, srcDur: SourceDuration = () => 0): Composition {
  let changed = false
  const layers = comp.layers.map((l) => {
    if (l.content.kind === 'layout') {
      const cells = l.content.cells.map((cell) => {
        if (!cell.comp) return cell
        const next = syncCompoundWindows(cell.comp, srcDur)
        if (next === cell.comp) return cell
        changed = true
        return { ...cell, comp: next }
      })
      return changed ? { ...l, content: { ...l.content, cells } } : l
    }
    if (l.content.kind !== 'compound') return l
    const inner = syncCompoundWindows(l.content.comp, srcDur)
    const end = l.startSec + Math.max(0.1, compositionDuration(inner, srcDur))
    if (inner === l.content.comp && Math.abs(end - l.endSec) < 1e-6) return l
    changed = true
    return { ...l, endSec: end, content: { ...l.content, comp: inner } }
  })
  return changed ? { ...comp, layers } : comp
}

/**
 * Every placement of `mediaId` in `comp` (recursing into compound layers and
 * layout-cell comps) reset to the WHOLE source of `durationSec`. Relinking a
 * clip to a file of a different length discards the old cuts
 * (docs/MEDIA-POINTERS.md "Relink"; choosing how to keep them is a TODO):
 * - video: in 0 → out `durationSec`; freeze holds and the speed ramp go (they
 *   are source-time data about the old file); a constant speed stays; the
 *   layer's end follows via `playedVideoDuration`.
 * - audio clips and layout cells: in 0 → out `durationSec`.
 * Returns the input unchanged when nothing referenced the media. Compound
 * windows re-sync on commit (`syncCompoundWindows`).
 */
export function resetMediaCuts<T extends Composition>(comp: T, mediaId: string, durationSec: number): T {
  let changed = false
  const layers = comp.layers.map((l): Layer => {
    const c = l.content
    if (c.kind === 'video' && c.mediaId === mediaId) {
      changed = true
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { freezes, speedRamp, ...rest } = c
      const content = { ...rest, inSec: 0, outSec: durationSec }
      return { ...l, endSec: l.startSec + playedVideoDuration(content), content }
    }
    if (c.kind === 'compound') {
      const inner = resetMediaCuts(c.comp, mediaId, durationSec)
      if (inner === c.comp) return l
      changed = true
      return { ...l, content: { ...c, comp: inner } }
    }
    if (c.kind === 'layout') {
      let cellsChanged = false
      const cells = c.cells.map((cell): LayoutCell => {
        if (cell.comp) {
          const inner = resetMediaCuts(cell.comp, mediaId, durationSec)
          if (inner === cell.comp) return cell
          cellsChanged = true
          return { ...cell, comp: inner }
        }
        if (cell.mediaId !== mediaId) return cell
        cellsChanged = true
        return { ...cell, inSec: 0, outSec: durationSec }
      })
      if (!cellsChanged) return l
      changed = true
      return { ...l, content: { ...c, cells } }
    }
    return l
  })
  const audioClips = comp.audioClips.map((a) => {
    if (a.mediaId !== mediaId) return a
    changed = true
    return { ...a, inSec: 0, outSec: durationSec }
  })
  return changed ? { ...comp, layers, audioClips } : comp
}

/**
 * Human labels for each step of a path, resolved against the document — the
 * breadcrumb's text ("Compound clip", "Layout · Cell 2", …). Unresolvable
 * steps label as "?" so a transient stale path can't crash the header.
 */
export function compPathLabels(root: Composition, path: CompPath): string[] {
  const labels: string[] = []
  let comp: Composition | null = root
  for (const step of path) {
    const layer = comp?.layers.find((l) => l.id === step.layerId)
    const base = layer ? layerLabel(layer) : '?'
    labels.push(step.cellIndex === undefined ? base : `${base} · Cell ${step.cellIndex + 1}`)
    comp = comp ? stepInto(comp, step) : null
  }
  return labels
}

/** Depth of the composition tree (a comp with no nesting = 1). The enter /
 *  convert actions refuse when the result would exceed `MAX_COMP_DEPTH`. */
export function compDepth(comp: Composition): number {
  let deepest = 0
  for (const l of comp.layers) {
    if (l.content.kind === 'compound') deepest = Math.max(deepest, compDepth(l.content.comp))
    if (l.content.kind === 'layout') {
      for (const cell of l.content.cells) {
        if (cell.comp) deepest = Math.max(deepest, compDepth(cell.comp))
      }
    }
  }
  return 1 + deepest
}

/**
 * Seed a composition from a single-clip layout CELL — the "edit this panel"
 * conversion. The cell's clip becomes a full-frame video layer at local t=0
 * keeping its trim and mute; an empty cell yields an empty comp. The caller
 * swaps it into `cell.comp` (and may clear `mediaId`).
 */
export function makeCompFromCell(
  cell: Pick<LayoutCell, 'mediaId' | 'inSec' | 'outSec' | 'mute'>,
  makeId: () => string
): Composition {
  const comp = createEmptyComposition()
  if (!cell.mediaId) return comp
  const dur = Math.max(0.1, cell.outSec - cell.inSec)
  const layer: Layer = {
    id: makeId(),
    hidden: false,
    startSec: 0,
    endSec: dur,
    x: FRAME.width / 2,
    y: FRAME.height / 2,
    scale: 1,
    content: {
      kind: 'video',
      mediaId: cell.mediaId,
      inSec: cell.inSec,
      outSec: cell.outSec,
      mute: cell.mute,
      gainDb: 0,
      crop: null
    }
  }
  return { ...comp, layers: [layer] }
}

/**
 * Seed a composition from an existing timeline LAYER — "convert to compound
 * clip". The layer is moved to local t=0 with its window, content (trim,
 * speed, freezes, keyframes…) and transform intact; the caller replaces the
 * original with a compound layer spanning the same parent window.
 */
export function makeCompFromLayer(layer: Layer): Composition {
  const dur = Math.max(0.1, layer.endSec - layer.startSec)
  return {
    ...createEmptyComposition(),
    layers: [{ ...layer, startSec: 0, endSec: dur, linkGroupId: undefined }]
  }
}
