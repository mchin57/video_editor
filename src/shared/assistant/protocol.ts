/**
 * The assistant bridge: ops the MCP server (main) asks the renderer to run
 * against the real store, with their argument and result types. One table, so
 * main's `callRenderer` and the renderer's handlers can't drift apart.
 */

import type { Project, TimelineItemRef } from '../project'
import type { CompPath } from '../compositions'
import type { TimelineSummary } from './timelineSummary'
import type { OnScreenText, TextEdit, TextEditResult, TextQuery } from './onScreenText'

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
  /** The project plus the path to the composition the editor shows (empty = the
   *  root; else the compound clip / layout cell the user entered) — what get_text /
   *  get_timeline / set_playhead times refer to. One snapshot, so the two agree. */
  getRenderTarget: { args: NoArgs; result: { project: Project; editPath: CompPath } }
  /** `sourceDurations` as for setPlayhead: the edit's length decides which captions can show. */
  getText: { args: TextQuery & { sourceDurations: Record<string, number> }; result: OnScreenText }
  /** All edits are ONE undo step; any invalid edit throws and nothing changes. */
  applyTextEdits: { args: { edits: TextEdit[]; sourceDurations: Record<string, number> }; result: TextEditResult[] }
  /**
   * Move the playhead (view state; no undo step). `sourceDurations` (main fills
   * it from the library) lets the renderer measure open-ended audio for the clamp.
   */
  setPlayhead: {
    args: { timeSec: number; sourceDurations: Record<string, number> }
    result: { timeSec: number; durationSec: number }
  }
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
