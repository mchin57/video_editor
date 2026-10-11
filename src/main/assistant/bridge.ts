/**
 * Main half of the assistant bridge: ask the renderer to run a store op and
 * await its answer. Edits must run in the renderer — that is where the store,
 * its undo history and its invariants live.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC, IPC_EVENT } from '@shared/ipc'
import type { AssistantOp, AssistantOps, AssistantRequest, AssistantResponse } from '@shared/assistant/protocol'

export const RENDERER_TIMEOUT_MS = 10_000
/** How far ahead of the timeout a request expires in the renderer (see `AssistantRequest.deadline`). */
const EXPIRY_MARGIN_MS = 1_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
const pending = new Map<string, Pending>()

/** Listen for renderer answers. Call once, from registerIpcHandlers. */
export function registerAssistantBridge(): void {
  ipcMain.on(IPC.assistantResponse, (_e, res: AssistantResponse) => {
    const p = pending.get(res.id)
    if (!p) return
    pending.delete(res.id)
    clearTimeout(p.timer)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error))
  })
}

/** The editor window (the first one created). */
function editorWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .sort((a, b) => a.id - b.id)[0]
}

export function callRenderer<K extends AssistantOp>(
  op: K,
  args: AssistantOps[K]['args']
): Promise<AssistantOps[K]['result']> {
  const win = editorWindow()
  if (!win) return Promise.reject(new Error('The editor window is not open'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(
        new Error(
          `The editor did not answer "${op}" within ${RENDERER_TIMEOUT_MS / 1000}s (it may be showing a dialog, or the user is holding a drag). Nothing was changed; it is safe to retry.`
        )
      )
    }, RENDERER_TIMEOUT_MS)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    const req: AssistantRequest<K> = { id, op, args, deadline: Date.now() + RENDERER_TIMEOUT_MS - EXPIRY_MARGIN_MS }
    win.webContents.send(IPC_EVENT.assistantRequest, req)
  })
}
