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
import { randomUUID } from 'node:crypto'
import { LineDecoder, encodeLine, type PipeRequest, type PipeResponse, type ToolContent } from '@shared/assistant/pipeProtocol'

export type PipeHandler = (tool: string, args: unknown) => Promise<ToolContent[]>

export const NOT_RUNNING =
  "Reel Editor isn't running, or its AI assistant is switched off in Settings. Open it and try again."
export const IN_USE = 'Another copy of the editor is already connected to Claude Code'

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
        sock.end(encodeLine({ id: '', ok: false, error: 'Malformed request' } satisfies PipeResponse))
        return
      }
      for (const m of msgs) void answer(sock, m as PipeRequest, handle)
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
  let res: PipeResponse
  try {
    res = { id: req.id, ok: true, content: await handle(req.tool, req.args) }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!sock.destroyed) sock.end(encodeLine(res))
}

export function callPipe(path: string, tool: string, args: unknown): Promise<ToolContent[]> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
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
      const res = msgs.find((m) => (m as PipeResponse).id === id) as PipeResponse | undefined
      if (!res) return
      settle(() => (res.ok ? resolve(res.content) : reject(new Error(res.error))))
      sock.end()
    })
    sock.on('error', (err: NodeJS.ErrnoException) =>
      settle(() => reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? NOT_RUNNING : err.message)))
    )
    sock.on('close', () => settle(() => reject(new Error('Reel Editor closed the connection before answering'))))
  })
}
