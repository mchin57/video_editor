/**
 * File assistant feature requests into the repo's docs/TODO.md. Writes are
 * serialized: Claude Code can issue tool calls in parallel, and two
 * read-modify-writes racing would drop one request.
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { writeAtomically } from '../services/atomicWrite'
import { appendAssistantRequest, type FeatureRequest } from './todoAppend'

export type FileResult = { status: 'added'; entry: string; path: string } | { status: 'duplicate'; path: string }

/** The checkout the app was launched from (npm run dev); REEL_TODO_PATH overrides (e2e). */
export const todoPath = (): string => process.env.REEL_TODO_PATH || join(app.getAppPath(), 'docs', 'TODO.md')

/** Local calendar date, YYYY-MM-DD. */
const today = (): string => new Date().toLocaleDateString('en-CA')

let queue: Promise<unknown> = Promise.resolve()

export function fileFeatureRequest(req: FeatureRequest): Promise<FileResult> {
  const run = queue.then(() => writeRequest(req))
  queue = run.catch(() => {})
  return run
}

async function writeRequest(req: FeatureRequest): Promise<FileResult> {
  const path = todoPath()
  let markdown: string
  try {
    markdown = await fsp.readFile(path, 'utf8')
  } catch {
    throw new Error(`Could not read the TODO list at ${path}`)
  }
  const r = appendAssistantRequest(markdown, req, today())
  if (r.status === 'duplicate') return { status: 'duplicate', path }
  await writeAtomically(path, (part) => fsp.writeFile(part, r.markdown, 'utf8'))
  return { status: 'added', entry: r.entry, path }
}
