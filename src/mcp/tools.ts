/**
 * reel-mcp's tool definitions: names, descriptions and argument schemas the
 * model sees. Each call is forwarded to the running editor (src/main/assistant/
 * tools.ts does the work). `CallEditor` ties every schema to `ToolArgs`, so a
 * schema that drifts from the editor's handler fails to compile.
 * Times: "source" = seconds into a media file; "timeline" = seconds in the edit.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContent } from '@shared/assistant/pipeProtocol'
import type { ToolArgs, ToolName } from '@shared/assistant/toolArgs'
import { FONTS } from '@shared/fonts'
import { TEXT_FONT_SIZE_MAX, TEXT_FONT_SIZE_MIN } from '@shared/assistant/onScreenText'

export type CallEditor = <K extends ToolName>(tool: K, args: ToolArgs[K]) => Promise<ToolContent[]>

const result = (content: ToolContent[]): CallToolResult => ({ content })

export function registerTools(server: McpServer, call: CallEditor): void {
  server.registerTool(
    'list_media',
    {
      description:
        "List the clips in the open project's media library: id, file name, path on disk, kind, duration (s), audio, picture size, whether a transcript exists, whether the preview proxy is ready."
    },
    async () => result(await call('list_media', {}))
  )

  server.registerTool(
    'import_media',
    {
      description:
        'Import files or folders from this computer into the project library (a folder imports the media inside it). Returns {imported: the new library entries, skipped: files that failed, with why}. Paths must be absolute. Only use paths the user gave you.',
      inputSchema: { paths: z.array(z.string().min(1)).min(1).describe('Absolute paths of files or folders') }
    },
    async (args) => result(await call('import_media', args))
  )

  server.registerTool(
    'get_transcript',
    {
      description:
        'Timed transcript of a clip in SOURCE seconds. Transcribes the clip first if needed (can take a minute; progress shows in the editor). Default: one line per phrase "[start–end] text". Set words=true for one line per word (best with a fromSec/toSec range) when you need to cut on an exact word.',
      inputSchema: {
        mediaId: z.string(),
        fromSec: z.number().min(0).optional(),
        toSec: z.number().min(0).optional(),
        words: z.boolean().optional()
      }
    },
    async (args) => result(await call('get_transcript', args))
  )

  server.registerTool(
    'get_frames',
    {
      description:
        'Small still frames (≈360px wide JPEG) from a clip at SOURCE times, to judge the picture. Give explicit times, or a count for evenly spaced frames. At most 8.',
      inputSchema: {
        mediaId: z.string(),
        times: z.array(z.number().min(0)).min(1).max(8).optional(),
        count: z.number().int().min(1).max(8).optional()
      }
    },
    async (args) => result(await call('get_frames', args))
  )

  server.registerTool(
    'get_timeline',
    {
      description:
        'What is on the timeline now (the composition open in the editor): each layer with TIMELINE start/end and, for video, its SOURCE in/out; audio clips; total duration.'
    },
    async () => result(await call('get_timeline', {}))
  )

  server.registerTool(
    'place_sequence',
    {
      description:
        'Lay clips end-to-end on the timeline in EXACTLY the given order. Each item is a SOURCE window {mediaId, inSec, outSec}. mode "append" (default) adds after the current end; "replace" first removes the existing video clips (and their linked audio) and starts at 0. Clips with sound bring linked audio, like a drag from the library. New clips go on the top layer; with "replace" they take the layer of the removed video (the lowest one, if several). The whole call is ONE undo step. Prefer one call for the whole cut.',
      inputSchema: {
        items: z
          .array(z.object({ mediaId: z.string(), inSec: z.number().min(0), outSec: z.number().positive() }))
          .min(1)
          .max(200),
        mode: z.enum(['append', 'replace']).optional(),
        atSec: z.number().min(0).optional().describe('TIMELINE second to start at')
      }
    },
    async (args) => result(await call('place_sequence', args))
  )

  server.registerTool(
    'remove_items',
    {
      description:
        'Delete timeline items by id (from get_timeline). Linked partners (a clip and its audio) go together. One undo step.',
      inputSchema: { ids: z.array(z.string()).min(1) }
    },
    async (args) => result(await call('remove_items', args))
  )

  server.registerTool(
    'undo',
    { description: "Undo the last edit (yours or the user's) — one step. Returns the timeline after undoing." },
    async () => result(await call('undo', {}))
  )

  server.registerTool(
    'export_video',
    {
      description:
        'Render the whole project to an .mp4 exactly as the Export button does, into the export folder from Settings unless you give a folder. Waits until the render finishes (progress shows in the editor). Never overwrites: a taken name gets " (2)". A finished export also saves the project, as the button does: the result has saved: true; saved: false with a reason when the user opened another project while it rendered (that one is not saved); or saveError (the export still succeeded) — pass either on to the user. Only export when the user asks.',
      inputSchema: {
        fileName: z.string().max(120).optional().describe('File name without folder, e.g. "beach reel"'),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe('Absolute path of an existing folder to write into, only when the user asked for one')
      }
    },
    async (args) => result(await call('export_video', args))
  )

  server.registerTool(
    'get_text',
    {
      description:
        'All text the viewer reads: text layers and caption segments in TIMELINE order, each with id, kind ("text" | "caption"), startSec/endSec, the text, whether it is visible (and why not), whether it is linked, and the style it actually renders with (font, size, colour, pill, stroke, shadow, gradient, centre x/y in the 1080x1920 frame, rotation). Captions say whether they follow the lane style or have their own. Also the caption lane itself (id "captions": on/off + lane-wide style) and durationSec, the length of the edit: captions do not extend it, so one starting at or after it says hiddenBecause "after the end of the edit", and one running past it has cutOffAtSec. Optional: ids, or fromSec/toSec to get what is on screen in that range (fromSec = toSec asks what shows at that moment).',
      inputSchema: {
        ids: z.array(z.string()).min(1).optional(),
        fromSec: z.number().min(0).optional().describe('TIMELINE second'),
        toSec: z.number().min(0).optional().describe('TIMELINE second')
      }
    },
    async (args) => result(await call('get_text', args))
  )

  const color = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).describe('#rrggbb or #rrggbbaa')
  const textEdit = z.strictObject({
    id: z.string().optional().describe('Item to patch (from get_text). Leave out to CREATE a new item. "captions" = the caption lane.'),
    kind: z.enum(['text', 'caption']).optional().describe('Only when creating; default "text" (a text layer on top)'),
    text: z.string().min(1).optional(),
    startSec: z.number().min(0).optional().describe('TIMELINE second'),
    endSec: z.number().positive().optional().describe('TIMELINE second'),
    visible: z.boolean().optional(),
    x: z.number().optional().describe('Centre x in the 1080x1920 frame'),
    y: z.number().optional().describe('Centre y in the 1080x1920 frame'),
    rotationDeg: z.number().optional().describe('Clockwise degrees'),
    fontFamily: z.enum(FONTS.map((f) => f.id) as [string, ...string[]]).optional(),
    fontSizePx: z.number().min(TEXT_FONT_SIZE_MIN).max(TEXT_FONT_SIZE_MAX).optional(),
    color: color.optional(),
    pill: z
      .strictObject({ enabled: z.boolean().optional(), color: color.optional(), padPx: z.number().min(0).max(200).optional() })
      .optional()
      .describe('Box behind the text; fields merge into the current pill'),
    stroke: z.strictObject({ widthPx: z.number().min(0).max(100), color }).nullable().optional().describe('Glyph outline (ignored while the pill is on); null removes'),
    shadow: z
      .strictObject({ distancePx: z.number().min(0).max(100), color, blur: z.number().min(0).max(50) })
      .nullable()
      .optional()
      .describe('null removes'),
    gradient: z.strictObject({ from: color, to: color, angle: z.number() }).nullable().optional().describe('Fill gradient, overrides color; null removes'),
    widthPx: z.number().min(40).max(4000).nullable().optional().describe('Text layers only: wrap width; null = hug the text'),
    followLaneStyle: z.boolean().optional().describe('Captions only: true drops its own style so it follows the lane again')
  })

  server.registerTool(
    'set_text',
    {
      description:
        'Create or change on-screen text. Each edit WITH an id patches that item: only the fields you give change (fix a caption by sending just {id, text}). An edit WITHOUT an id creates a new item and needs text, startSec and endSec (kind "caption" for a caption, otherwise a text layer on top; unset style uses the editor defaults). id "captions" restyles the whole caption lane or turns it on/off (visible). Style/position fields on a caption give it its own style. Timing cannot change on a linked item. The whole call is ONE undo step, and if any edit is invalid nothing changes. Returns the id of each item touched or created.',
      inputSchema: { edits: z.array(textEdit).min(1).max(200) }
    },
    async (args) => result(await call('set_text', args))
  )

  server.registerTool(
    'set_playhead',
    {
      description:
        "Move the editor's playhead to a TIMELINE second (pausing playback there) so the user sees that exact moment — e.g. the first point you want them to look at. Changes nothing in the edit.",
      inputSchema: { timeSec: z.number().min(0) }
    },
    async (args) => result(await call('set_playhead', args))
  )

  server.registerTool(
    'render_frame',
    {
      description:
        'The FINISHED picture at TIMELINE seconds — every layer, text and caption burned in exactly as the export renders it (unlike get_frames, which shows raw source footage). Use it to check how text actually looks on screen: cut off, off-frame, unreadable over the picture, overlapping. 1–4 times per call (all rendered in one pass); takes a few seconds. Times past the end show the last frame.',
      inputSchema: { times: z.array(z.number().min(0)).min(1).max(4) }
    },
    async (args) => result(await call('render_frame', args))
  )

  server.registerTool(
    'request_feature',
    {
      description:
        "File a feature request in the editor's TODO list when you need an ability these tools don't have (instead of approximating with tools that don't fit). Then tell the user what you filed.",
      inputSchema: {
        title: z.string().min(3).max(120).describe('Short name of the missing ability'),
        problem: z.string().min(10).describe('What you were trying to do and why the current tools could not'),
        proposal: z.string().min(5).describe('Suggested tool/API or behavior'),
        workaround: z.string().optional().describe('What you did instead, if anything')
      }
    },
    async (args) => result(await call('request_feature', args))
  )
}
