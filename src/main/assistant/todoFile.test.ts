// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => 'C:/not-used' } }))

import { fileFeatureRequest, todoPath } from './todoFile'

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'todo-')), 'TODO.md')
  writeFileSync(file, '# TODO\n\n## Open\n\n- [ ] x\n')
  process.env.REEL_TODO_PATH = file
})
afterEach(() => {
  delete process.env.REEL_TODO_PATH
})

describe('fileFeatureRequest', () => {
  it('uses REEL_TODO_PATH when set', () => {
    expect(todoPath()).toBe(file)
  })

  it('writes the entry and reports a repeat as a duplicate', async () => {
    const req = { title: 'Beat snap', problem: 'needed beats', proposal: 'detect_beats tool' }
    expect((await fileFeatureRequest(req)).status).toBe('added')
    expect((await fileFeatureRequest(req)).status).toBe('duplicate')
    expect(readFileSync(file, 'utf8').match(/Beat snap/g)).toHaveLength(1)
  })

  it('keeps both of two requests filed at the same time', async () => {
    await Promise.all([
      fileFeatureRequest({ title: 'One', problem: 'p1', proposal: 'q1' }),
      fileFeatureRequest({ title: 'Two', problem: 'p2', proposal: 'q2' })
    ])
    const md = readFileSync(file, 'utf8')
    expect(md).toContain('**One**')
    expect(md).toContain('**Two**')
  })

  it('fails clearly when the file is missing', async () => {
    process.env.REEL_TODO_PATH = join(tmpdir(), 'definitely-missing-TODO.md')
    await expect(fileFeatureRequest({ title: 'T', problem: 'p', proposal: 'q' })).rejects.toThrow(/Could not read the TODO list/)
  })
})
