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
        'Import files or folders from this computer into the project library (a folder imports the media inside it). Returns the new library entries. Only use paths the user gave you.',
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
        'Lay clips end-to-end on the timeline in EXACTLY the given order. Each item is a SOURCE window {mediaId, inSec, outSec}. mode "append" (default) adds after the current end; "replace" first removes the existing video clips (and their linked audio) and starts at 0. Clips with sound bring linked audio, like a drag from the library. The whole call is ONE undo step. Prefer one call for the whole cut.',
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
        'Render the whole project to an .mp4 exactly as the Export button does, into the export folder from Settings. Waits until the render finishes (progress shows in the editor). Never overwrites: a taken name gets " (2)". Only export when the user asks.',
      inputSchema: { fileName: z.string().max(120).optional().describe('File name without folder, e.g. "beach reel"') }
    },
    async (args) => result(await call('export_video', args))
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
