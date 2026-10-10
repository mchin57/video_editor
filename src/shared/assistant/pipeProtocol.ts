/**
 * Wire format between reel-mcp (the stdio MCP server Claude Code launches) and
 * the running editor: one JSON object per line over a named pipe. One
 * connection per tool call. Pure.
 */

/** MCP content blocks, passed straight through to Claude Code. */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PipeRequest {
  id: string
  tool: string
  args: unknown
}

export type PipeResponse = { id: string; ok: true; content: ToolContent[] } | { id: string; ok: false; error: string }

export const PIPE_NAME = 'reel-editor'

/** Where the editor listens: a Windows named pipe; a unix socket elsewhere (untested). */
export function defaultPipePath(platform: string, tmpDir: string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${PIPE_NAME}` : `${tmpDir.replace(/[\\/]+$/, '')}/${PIPE_NAME}.sock`
}

/** JSON.stringify escapes newlines inside strings, so one message is always one line. */
export const encodeLine = (msg: unknown): string => `${JSON.stringify(msg)}\n`

/** Incremental JSON-lines decoder: feed chunks, get whole messages back. Throws on a malformed line. */
export class LineDecoder {
  private buf = ''

  push(chunk: string): unknown[] {
    this.buf += chunk
    const out: unknown[] = []
    let nl = this.buf.indexOf('\n')
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) out.push(JSON.parse(line))
      nl = this.buf.indexOf('\n')
    }
    return out
  }
}
