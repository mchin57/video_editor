/**
 * File assistant feature requests as GitHub issues (`gh issue create`) in the
 * repo the app was launched from. Writes are serialized: Claude Code can issue
 * tool calls in parallel, and two requests racing the duplicate check would
 * file the same issue twice.
 *
 * REEL_ISSUES_SINK (e2e / unit tests) appends JSON lines to that file instead
 * of calling `gh`, so a test never touches the real tracker.
 */

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'

export interface FeatureRequest {
  title: string
  problem: string
  proposal: string
  workaround?: string
}

export type FileResult = { status: 'added'; entry: string; where: string } | { status: 'duplicate'; where: string }

export const ASSISTANT_LABELS = ['enhancement', 'assistant']

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Local calendar date, YYYY-MM-DD. */
const today = (): string => new Date().toLocaleDateString('en-CA')

export function formatIssue(req: FeatureRequest, date: string): { title: string; body: string } {
  const parts = [`**Problem.** ${oneLine(req.problem)}`, `**Proposal.** ${oneLine(req.proposal)}`]
  const workaround = req.workaround ? oneLine(req.workaround) : ''
  if (workaround) parts.push(`**Workaround used.** ${workaround}`)
  parts.push(`_Requested by the editor's assistant, ${date}._`)
  return { title: oneLine(req.title), body: parts.join('\n\n') }
}

const sameTitle = (a: string, b: string): boolean => oneLine(a).toLowerCase() === oneLine(b).toLowerCase()

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd: app.getAppPath(), timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).trim()}`))
      else resolve(stdout.trim())
    })
  })
}

async function fileToSink(sink: string, title: string, body: string): Promise<FileResult> {
  const existing = await fsp.readFile(sink, 'utf8').catch(() => '')
  const rows = existing.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { title: string })
  if (rows.some((r) => sameTitle(r.title, title))) return { status: 'duplicate', where: sink }
  await fsp.appendFile(sink, JSON.stringify({ title, body, labels: ASSISTANT_LABELS }) + '\n')
  return { status: 'added', entry: title, where: sink }
}

async function fileToGitHub(title: string, body: string): Promise<FileResult> {
  const open = JSON.parse(
    await gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'title,url'])
  ) as { title: string; url: string }[]
  const dup = open.find((i) => sameTitle(i.title, title))
  if (dup) return { status: 'duplicate', where: dup.url }
  const args = ['issue', 'create', '--title', title, '--body', body]
  for (const l of ASSISTANT_LABELS) args.push('--label', l)
  const url = await gh(args)
  return { status: 'added', entry: title, where: url }
}

let queue: Promise<unknown> = Promise.resolve()

export function fileFeatureRequest(req: FeatureRequest): Promise<FileResult> {
  const run = queue.then(() => {
    const { title, body } = formatIssue(req, today())
    const sink = process.env.REEL_ISSUES_SINK
    return sink ? fileToSink(sink, title, body) : fileToGitHub(title, body)
  })
  queue = run.catch(() => {})
  return run
}
