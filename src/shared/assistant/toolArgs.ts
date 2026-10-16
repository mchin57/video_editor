/**
 * Argument shape of each assistant tool. reel-mcp's zod schemas must produce
 * these (checked at compile time where it forwards a call) and the editor's
 * handlers consume them. Types only.
 */

import type { TextEdit, TextQuery } from './onScreenText'

type NoArgs = Record<string, never>

export interface ToolArgs {
  list_media: NoArgs
  import_media: { paths: string[] }
  get_transcript: { mediaId: string; fromSec?: number; toSec?: number; words?: boolean }
  get_frames: { mediaId: string; times?: number[]; count?: number }
  trim_clip: { mediaId: string; startSec: number; endSec: number }
  split_clip: { mediaId: string; times: number[] }
  merge_clips: { items: { mediaId: string; inSec?: number; outSec?: number }[] }
  add_description: { mediaId: string; description: string }
  get_timeline: NoArgs
  place_sequence: {
    items: { mediaId: string; inSec: number; outSec: number }[]
    mode?: 'append' | 'replace'
    atSec?: number
  }
  remove_items: { ids: string[] }
  undo: NoArgs
  export_video: { fileName?: string; folder?: string }
  get_text: TextQuery
  set_text: { edits: TextEdit[] }
  set_playhead: { timeSec: number }
  render_frame: { times: number[] }
  request_feature: { title: string; problem: string; proposal: string; workaround?: string }
}

export type ToolName = keyof ToolArgs
