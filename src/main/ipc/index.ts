/**
 * Main's IPC surface, by area. Every handler is registered through `handle`
 * (`handle.ts`), typed against the contract in shared/ipc.ts and argument-
 * checked by `schemas.ts`; main → renderer pushes go through `events.ts`.
 */

import { registerAssistantBridge } from '../assistant/bridge'
import { registerAnalysisHandlers } from './analysis'
import { registerExportHandlers } from './export'
import { registerMediaHandlers } from './media'
import { registerProjectHandlers } from './project'
import { registerSettingsHandlers } from './settings'

export function registerIpcHandlers(): void {
  registerAssistantBridge()
  registerSettingsHandlers()
  registerMediaHandlers()
  registerProjectHandlers()
  registerExportHandlers()
  registerAnalysisHandlers()
}
