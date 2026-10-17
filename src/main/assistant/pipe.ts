/**
 * The named pipe between reel-mcp and the editor. One connection per tool call:
 * one request line in, one response line out; a long call (export) just keeps
 * its connection open. No Electron imports — reel-mcp uses `callPipe`, and this
 * file is unit-tested against a real pipe.
 *
 * Why a pipe rather than local HTTP: an MCP-aware filter on the owner's machine
 * corrupts local plain-HTTP MCP traffic (design spec, "Why not local HTTP");
 * pipes and stdio are not network traffic and were verified unaffected.
 */

import net from 'node:net'
import {
  LineDecoder,
  encodeLine,
  type PipeRequest,
  type PipeResponse,
  type ToolContent
} from '@shared/assistant/pipeProtocol'
import { newId } from '@shared/ids'

export type PipeHandler = (tool: string, args: unknown) => Promise<ToolContent[]>

export const NOT_RUNNING =
  "Reel Editor isn't running, or its AI assistant is switched off in Settings. Open it and try again."
export const IN_USE = 'Another copy of the editor is already connected to Claude Code'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const isRequest = (v: unknown): v is PipeRequest =>
  isRecord(v) && typeof v.id === 'string' && typeof v.tool === 'string'

const errorLine = (id: string, error: string): string => encodeLine({ id, ok: false, error } satisfies PipeResponse)

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function servePipe(
  path: string,
  handle: PipeHandler
): Promise<{ ok: true; server: net.Server } | { ok: false; message: string }> {
  const server = net.createServer((sock) => {
    const decoder = new LineDecoder()
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      let msgs: unknown[]
      try {
        msgs = decoder.push(chunk)
      } catch {
        sock.end(errorLine('', 'Malformed request'))
        return
      }
      for (const m of msgs) {
        if (!isRequest(m)) {
          // Valid JSON but not a request: say so (echoing an id if it carried one) and hang up.
          sock.end(errorLine(isRecord(m) && typeof m.id === 'string' ? m.id : '', 'Malformed request'))
          return
        }
        // answer() is total; the catch is a last resort so nothing is ever unhandled.
        void answer(sock, m, handle).catch(() => sock.destroy())
      }
    })
    // The caller went away mid-call (e.g. Claude Code cancelled); nobody to tell.
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ ok: false, message: err.code === 'EADDRINUSE' ? IN_USE : err.message })
    )
    server.listen(path, () => resolve({ ok: true, server }))
  })
}

async function answer(sock: net.Socket, req: PipeRequest, handle: PipeHandler): Promise<void> {
  let line: string
  try {
    const content = await handle(req.tool, req.args)
    try {
      line = encodeLine({ id: req.id, ok: true, content } satisfies PipeResponse)
    } catch (e) {
      // e.g. a BigInt in the content: tell the caller instead of leaving it waiting forever.
      line = errorLine(req.id, `Tool "${req.tool}" returned content that could not be sent: ${messageOf(e)}`)
    }
  } catch (e) {
    line = errorLine(req.id, messageOf(e))
  }
  if (!sock.destroyed && !sock.writableEnded) sock.end(line)
}

export function callPipe(path: string, tool: string, args: unknown): Promise<ToolContent[]> {
  return new Promise((resolve, reject) => {
    const id = newId()
    const decoder = new LineDecoder()
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    const sock = net.connect(path)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(encodeLine({ id, tool, args } satisfies PipeRequest)))
    sock.on('data', (chunk: string) => {
      let msgs: unknown[]
      try {
        msgs = decoder.push(chunk)
      } catch {
        settle(() => reject(new Error('Reel Editor sent a malformed answer')))
        sock.destroy()
        return
      }
      for (const m of msgs) {
        // Anything that isn't an object is a protocol violation; an object for another id isn't ours.
        if (isRecord(m) && m.id !== id) continue
        if (isRecord(m) && m.ok === true && Array.isArray(m.content)) {
          const content = m.content as ToolContent[]
          settle(() => resolve(content))
          sock.end()
        } else if (isRecord(m) && m.ok === false && typeof m.error === 'string') {
          const error = m.error
          settle(() => reject(new Error(error)))
          sock.end()
        } else {
          settle(() => reject(new Error('Reel Editor sent a malformed answer')))
          sock.destroy()
        }
        return
      }
    })
    sock.on('error', (err: NodeJS.ErrnoException) =>
      settle(() => reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? NOT_RUNNING : err.message)))
    )
    sock.on('close', () => settle(() => reject(new Error('Reel Editor closed the connection before answering'))))
  })
}
