/** Typed main → renderer pushes (`IpcEvents` in shared/ipc.ts). Kept apart from
 *  `handle.ts` so services that only push (jobs) don't pull in the handlers. */

import { BrowserWindow, type WebContents } from 'electron'
import { IPC_EVENT, type IpcEvents } from '@shared/ipc'

/** Push an event to one window's renderer (dropped if it has gone away). */
export function sendTo<E extends keyof IpcEvents>(target: WebContents, name: E, ...payload: IpcEvents[E]): void {
  if (!target.isDestroyed()) target.send(IPC_EVENT[name], ...payload)
}

/** Push an event to every open window. */
export function broadcast<E extends keyof IpcEvents>(name: E, ...payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) sendTo(win.webContents, name, ...payload)
  }
}
