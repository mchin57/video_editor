/**
 * Serves Claude Code (via reel-mcp) on the named pipe while the assistant is
 * enabled in Settings. Status feeds the Settings panel.
 */

import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultPipePath } from '@shared/assistant/pipeProtocol'
import type { AssistantStatus } from '@shared/assistant/protocol'
import { getSettings } from '../services/settings'
import { servePipe } from './pipe'
import { handleTool } from './tools'
import { createLogger } from '@shared/log'

const log = createLogger('assistant')

/** reel-mcp's built entry, beside this bundle (out/main/mcp.js). */
export const mcpScriptPath = (): string => join(__dirname, 'mcp.js')

export const pipePath = (): string => process.env.REEL_ASSISTANT_PIPE || defaultPipePath(process.platform, tmpdir())

let server: Server | null = null
let state: Omit<AssistantStatus, 'scriptPath'> = { state: 'off' }

export const assistantStatus = (): AssistantStatus => ({ ...state, scriptPath: mcpScriptPath() })

/**
 * Every start and stop runs one at a time. Overlapping calls would otherwise
 * both see `server === null` and both listen, so the loser reports a false
 * "another copy" error; and on Windows a re-listen fails with EADDRINUSE until
 * the previous server has finished draining, so a start has to wait for a stop.
 */
let chain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

/** Settles once the last stopped server has finished the calls it had in flight. */
let drained: Promise<void> = Promise.resolve()

/**
 * Stop accepting calls now (one connection per call, so close() refuses every
 * new call — though on Windows a new connect waits until the drain ends, then
 * fails as "not running"; verified). Calls already in flight (e.g. an export)
 * finish in the background; `drained` tracks them.
 */
function stopListening(): void {
  const s = server
  server = null
  state = { state: 'off' }
  if (s) drained = new Promise<void>((resolve) => s.close(() => resolve()))
}

/**
 * (Re)start from the current settings. Never rejects: a failure becomes the
 * error status. Switching off answers as soon as listening stops, without
 * waiting for an in-flight export, so the Settings toggle doesn't hang; only a
 * re-listen has to wait for the drain.
 */
export const startAssistant = (): Promise<AssistantStatus> =>
  serialized(async () => {
    stopListening()
    try {
      const { assistant } = await getSettings()
      if (assistant.enabled) {
        await drained
        const r = await servePipe(pipePath(), handleTool)
        if (r.ok) {
          server = r.server
          state = { state: 'listening' }
        } else {
          state = { state: 'error', message: r.message }
          log.error(r.message)
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      state = { state: 'error', message }
      log.error(message)
    }
    return assistantStatus()
  })

/** Stop accepting calls. Waits for calls already in flight (e.g. an export) to finish. */
export const stopAssistant = (): Promise<void> =>
  serialized(async () => {
    stopListening()
    await drained
  })
