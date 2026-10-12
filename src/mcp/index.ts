/**
 * reel-mcp: the stdio MCP server Claude Code launches with
 * `node out/main/mcp.js` (registration command in Settings → AI assistant).
 * Every tool call is forwarded over a named pipe to the running editor.
 * stdout IS the MCP channel — never print to it; diagnostics go to stderr.
 * Must not import electron (it runs under plain node).
 */

import { tmpdir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultPipePath } from '@shared/assistant/pipeProtocol'
import { callPipe } from '../main/assistant/pipe'
import { registerTools } from './tools'

const INSTRUCTIONS =
  'Tools for the Reel Editor desktop app on this computer. Times are seconds: SOURCE time is a position inside a media file, TIMELINE time is a position in the edit. Workflow: list_media, get_transcript (and get_frames when the picture matters), choose the cut, one place_sequence call, then get_timeline to verify. On-screen text and captions: get_text to read, one set_text call to fix/create (no id = new item), render_frame to see the finished picture. After an edit, have the result audited (the /edit-video skill\'s reel-auditor), auto-fix clear errors, and bring judgement calls and disagreements to the user with timeline timestamps, set_playhead on the first. An order the user gives is authoritative. Export only when asked. If an ability is missing, call request_feature instead of approximating.'

const pipePath = process.env.REEL_ASSISTANT_PIPE || defaultPipePath(process.platform, tmpdir())

const server = new McpServer({ name: 'reel-editor', version: '0.1.0' }, { instructions: INSTRUCTIONS })
registerTools(server, (tool, args) => callPipe(pipePath, tool, args))
server.connect(new StdioServerTransport()).catch((err) => {
  console.error('[reel-mcp] failed to start', err)
  process.exit(1)
})
