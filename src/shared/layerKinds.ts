/**
 * What each layer kind IS and CAN DO, in one table. Code that asks "can this
 * layer rotate?", "what is it called?", "do keyframes move it?" reads the answer
 * here instead of listing kinds inline (`kind === 'video' || kind === 'image' …`).
 * An inline list goes stale silently when a kind is added — that is how a
 * compound layer came to be titled "Text layer" (#98) — while this table is
 * `satisfies Record<LayerKind, …>`, so a new kind without an entry is a compile
 * error.
 *
 * Narrowing on `content.kind` to reach kind-specific FIELDS (`c.kind === 'video'`
 * before reading `c.inSec`) stays where it is: that is TypeScript doing its job.
 * This table is for the questions whose answer is a property of the kind.
 */

import type { LayerContent, LayerKind } from './project'

/** How a layer's `keyframes` drive it:
 *  - `transform` — position, scale and opacity, in the preview and the export;
 *  - `path`      — position only, as straight-line motion (text: `textMotion`);
 *  - `none`      — ignored (no export keyframe path for this kind). */
export type KeyframeMode = 'transform' | 'path' | 'none'

/** Which canvas resize handles the kind gets (sets live in PreviewStage). */
export type ResizeHandleSet = 'media' | 'text' | 'corners' | 'none'

export interface LayerKindInfo {
  /** Inspector heading for the selected layer. */
  title: string
  /** Name of an unnamed layer (a text layer shows its text instead; `layerLabel`). */
  name: string
  /** Icon in the Layers panel and on timeline tiles. */
  icon: string
  /** The rotate handle and the Rotation field. Layouts and compound clips render
   *  as frame-shaped comps and ignore `rotationDeg` (backlogged). */
  rotatable: boolean
  /** The Inspector's straight-line Motion section (start → end move). */
  motion: boolean
  keyframes: KeyframeMode
  handles: ResizeHandleSet
}

export const LAYER_KINDS = {
  video: {
    title: 'Video layer',
    name: 'Video',
    icon: '🎬',
    rotatable: true,
    motion: true,
    keyframes: 'transform',
    handles: 'media'
  },
  image: {
    title: 'Image layer',
    name: 'Image',
    icon: '🖼',
    rotatable: true,
    motion: true,
    keyframes: 'transform',
    handles: 'media'
  },
  text: {
    title: 'Text layer',
    name: 'Text',
    icon: '🅣',
    rotatable: true,
    motion: true,
    keyframes: 'path',
    handles: 'text'
  },
  layout: {
    title: 'Layout layer',
    name: 'Layout',
    icon: '▦',
    rotatable: false,
    motion: false,
    keyframes: 'none',
    handles: 'corners'
  },
  compound: {
    title: 'Compound clip',
    name: 'Compound clip',
    icon: '🧩',
    rotatable: false,
    motion: false,
    keyframes: 'none',
    handles: 'media'
  },
  graphics: {
    title: 'Graphics layer',
    name: 'Graphics',
    icon: '✏️',
    // The drawing is edited mark by mark (point handles), not as a box; the
    // layer moves/zooms as a whole through its Motion keyframes.
    rotatable: false,
    motion: true,
    keyframes: 'transform',
    handles: 'none'
  }
} as const satisfies Record<LayerKind, LayerKindInfo>

/** The table entry for a layer (or its content). */
export const kindInfo = (l: { content: Pick<LayerContent, 'kind'> }): LayerKindInfo => LAYER_KINDS[l.content.kind]

/** The library clip a layer shows directly (video and image layers), else null.
 *  Layout cells and compound clips hold clips too, nested — walk those with
 *  `mediaUses`. */
export const layerMediaId = (c: LayerContent): string | null =>
  c.kind === 'video' || c.kind === 'image' ? c.mediaId : null

/** Exhaustiveness guard for a `switch` over a union: a case left unhandled makes
 *  the call a compile error. Throws if reached at runtime (bad data). */
export function assertNever(x: never, what = 'value'): never {
  throw new Error(`Unexpected ${what}: ${JSON.stringify(x)}`)
}
