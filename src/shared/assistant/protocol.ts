/**
 * The assistant bridge: ops the MCP server (main) asks the renderer to run
 * against the real store, with their argument and result types. One table, so
 * main's `callRenderer` and the renderer's handlers can't drift apart.
 */

import type { Project, TimelineItemRef } from '../project'
import type { TimelineSummary } from './timelineSummary'

/** One clip in a rough cut. In/out are SOURCE seconds. */
export interface SequenceItem {
  mediaId: string
  inSec: number
  outSec: number
  /** Facts the renderer can't look up itself — main fills them from the library. */
  sourceDurationSec: number
  hasAudio: boolean
  aspect?: number
}

export interface SequencePlan {
  items: SequenceItem[]
  /** append: after the current end; replace: clear existing video clips first and start at 0. */
  mode: 'append' | 'replace'
  /** Timeline second to start at (overrides the mode's default). */
  atSec?: number
}

export interface PlacedClip {
  layerId: string
  mediaId: string
  inSec: number
  outSec: number
  startSec: number
  endSec: number
}

type NoArgs = Record<string, never>

export interface AssistantOps {
  getMediaIds: { args: NoArgs; result: string[] }
  addMedia: { args: { ids: string[] }; result: null }
  getTimeline: { args: NoArgs; result: TimelineSummary }
  placeSequence: { args: SequencePlan; result: PlacedClip[] }
  removeItems: { args: { ids: string[] }; result: { removed: TimelineItemRef[] } }
  undo: { args: NoArgs; result: { undone: boolean; timeline: TimelineSummary } }
  getProject: { args: NoArgs; result: Project }
  /** The store's `save` (File > Save): writes the open project to its `.reel` —
   *  only if it is still project `projectId` (the one an export came from). */
  saveProject: { args: { projectId: string }; result: { saved: true } | { saved: false; reason: string } }
}

export type AssistantOp = keyof AssistantOps

export interface AssistantRequest<K extends AssistantOp = AssistantOp> {
  id: string
  op: K
  args: AssistantOps[K]['args']
  /**
   * Epoch ms after which the renderer must NOT run this op: main has already
   * reported a timeout, so a late edit would land unannounced and a retry could
   * place the cut twice. Set short of main's timeout so an op that runs just in
   * time also answers in time.
   */
  deadline: number
}

export type AssistantResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }

/** What Settings shows about the Claude Code connection. */
export interface AssistantStatus {
  state: 'off' | 'listening' | 'error'
  /** Why, when state is 'error'. */
  message?: string
  /** Absolute path of reel-mcp's built entry (out/main/mcp.js) for the registration command. */
  scriptPath: string
}
