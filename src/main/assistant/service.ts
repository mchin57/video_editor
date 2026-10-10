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

/** Stop accepting calls, then wait for calls already in flight (e.g. an export) to finish. */
async function stop(): Promise<void> {
  const s = server
  server = null
  state = { state: 'off' }
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
}

/** (Re)start from the current settings. Never rejects: a failure becomes the error status. */
export const startAssistant = (): Promise<AssistantStatus> =>
  serialized(async () => {
    await stop()
    try {
      const { assistant } = await getSettings()
      if (assistant.enabled) {
        const r = await servePipe(pipePath(), handleTool)
        if (r.ok) {
          server = r.server
          state = { state: 'listening' }
        } else {
          state = { state: 'error', message: r.message }
          console.error('[assistant]', r.message)
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      state = { state: 'error', message }
      console.error('[assistant]', message)
    }
    return assistantStatus()
  })

/** Stop accepting calls. Waits for calls already in flight (e.g. an export) to finish. */
export const stopAssistant = (): Promise<void> => serialized(stop)
