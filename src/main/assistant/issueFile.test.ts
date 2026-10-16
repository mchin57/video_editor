// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => 'C:/not-used' } }))

import { fileFeatureRequest, formatIssue } from './issueFile'

let sink: string
beforeEach(() => {
  sink = join(mkdtempSync(join(tmpdir(), 'issues-')), 'sink.jsonl')
  process.env.REEL_ISSUES_SINK = sink
})
afterEach(() => {
  delete process.env.REEL_ISSUES_SINK
})

const rows = (): { title: string; body: string; labels: string[] }[] =>
  readFileSync(sink, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('formatIssue', () => {
  it('puts the problem, proposal and optional workaround in the body', () => {
    const { title, body } = formatIssue(
      { title: ' Beat  snap ', problem: 'needed\nbeats', proposal: 'detect_beats', workaround: 'by ear' },
      '2026-10-16'
    )
    expect(title).toBe('Beat snap')
    expect(body).toBe(
      '**Problem.** needed beats\n\n**Proposal.** detect_beats\n\n**Workaround used.** by ear\n\n_Requested by the editor\'s assistant, 2026-10-16._'
    )
  })
})

describe('fileFeatureRequest', () => {
  it('files the request with the assistant labels and reports a repeat as a duplicate', async () => {
    const req = { title: 'Beat snap', problem: 'needed beats', proposal: 'detect_beats tool' }
    expect((await fileFeatureRequest(req)).status).toBe('added')
    expect((await fileFeatureRequest({ ...req, title: 'beat SNAP' })).status).toBe('duplicate')
    expect(rows()).toHaveLength(1)
    expect(rows()[0].labels).toEqual(['enhancement', 'assistant'])
  })

  it('keeps both of two requests filed at the same time', async () => {
    await Promise.all([
      fileFeatureRequest({ title: 'One', problem: 'p1', proposal: 'q1' }),
      fileFeatureRequest({ title: 'Two', problem: 'p2', proposal: 'q2' })
    ])
    expect(rows().map((r) => r.title).sort()).toEqual(['One', 'Two'])
  })
})
