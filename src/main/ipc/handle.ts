/**
 * Registering IPC handlers against the contract (`IpcInvoke` / `IpcSend` in
 * shared/ipc.ts). `handle` types a handler's parameters and result from the
 * contract, so a handler can't drift from what the preload sends, and checks
 * the arguments at runtime first (`schemas.ts`): the renderer is a separate,
 * less trusted process, and a malformed call should fail with a reason before
 * it reaches a service, not halfway through one.
 */

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue
} from 'electron'
import type { z } from 'zod'
import { IPC, type InvokeArgs, type InvokeName, type InvokeResult, type IpcSend } from '@shared/ipc'
import { argsProblem, INVOKE_SCHEMAS, SEND_SCHEMAS } from './schemas'

/** Handle an invoke channel. The handler gets the ORIGINAL arguments once they
 *  pass the check (validation gates, it never rewrites a call). */
export function handle<K extends InvokeName>(
  name: K,
  fn: (event: IpcMainInvokeEvent, ...args: InvokeArgs<K>) => InvokeResult<K> | Promise<InvokeResult<K>>
): void {
  const schema: z.ZodType = INVOKE_SCHEMAS[name]
  ipcMain.handle(IPC[name], (event, ...args: unknown[]) => {
    const problem = argsProblem(schema, args)
    if (problem) throw new Error(`Bad request to ${IPC[name]}: ${problem}`)
    return fn(event, ...(args as InvokeArgs<K>))
  })
}

/** Handle a one-way message. A malformed one is logged and dropped (there is
 *  no caller to reject). */
export function onSend<K extends keyof IpcSend>(name: K, fn: (...args: IpcSend[K]) => void): void {
  const schema: z.ZodType = SEND_SCHEMAS[name]
  ipcMain.on(IPC[name], (_event, ...args: unknown[]) => {
    const problem = argsProblem(schema, args)
    if (problem) {
      console.error(`Dropped a bad ${IPC[name]} message: ${problem}`)
      return
    }
    fn(...(args as IpcSend[K]))
  })
}

/** Native dialogs for a request: parented to the window that asked, or
 *  unparented if that window has gone. */
export function dialogsFor(event: IpcMainInvokeEvent): {
  open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
  save: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>
  ask: (box: MessageBoxOptions) => Promise<MessageBoxReturnValue>
} {
  const win = BrowserWindow.fromWebContents(event.sender)
  return {
    open: (o) => (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o)),
    save: (o) => (win ? dialog.showSaveDialog(win, o) : dialog.showSaveDialog(o)),
    ask: (b) => (win ? dialog.showMessageBox(win, b) : dialog.showMessageBox(b))
  }
}

/** The one path an open dialog picked (null = canceled or nothing chosen). */
export const pickedPath = (r: OpenDialogReturnValue): string | null => (r.canceled ? null : (r.filePaths[0] ?? null))
