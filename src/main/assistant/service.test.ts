// @vitest-environment node
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callPipe } from './pipe'
import { handleTool } from './tools'

// service.ts reads settings and routes calls through handleTool; both pull in
// Electron-only modules, so they are replaced here.
const settings = vi.hoisted(() => ({ enabled: true, failure: null as Error | null }))
vi.mock('../services/settings', () => ({
  getSettings: vi.fn(async () => {
    if (settings.failure) throw settings.failure
    return { assistant: { enabled: settings.enabled } }
  })
}))
vi.mock('./tools', () => ({ handleTool: vi.fn(async () => []) }))

import { assistantStatus, pipePath, startAssistant, stopAssistant } from './service'

let n = 0
const uniquePipe = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\reel-svc-test-${process.pid}-${++n}`
    : join(tmpdir(), `reel-svc-test-${process.pid}-${++n}.sock`)

const savedPipe = process.env.REEL_ASSISTANT_PIPE

beforeEach(() => {
  process.env.REEL_ASSISTANT_PIPE = uniquePipe()
  settings.enabled = true
  settings.failure = null
  vi.mocked(handleTool).mockImplementation(async () => [])
})

afterEach(async () => {
  await stopAssistant()
  if (savedPipe === undefined) delete process.env.REEL_ASSISTANT_PIPE
  else process.env.REEL_ASSISTANT_PIPE = savedPipe
})

describe('assistant service', () => {
  it('listens on the configured pipe when enabled', async () => {
    const status = await startAssistant()
    expect(status.state).toBe('listening')
    expect(status.scriptPath).toMatch(/mcp\.js$/)
    expect(await callPipe(pipePath(), 'get_timeline', {})).toEqual([])
  })

  it('stays off when the assistant is disabled in settings', async () => {
    settings.enabled = false
    const status = await startAssistant()
    expect(status.state).toBe('off')
    expect(assistantStatus().state).toBe('off')
  })

  it('stops and starts again', async () => {
    expect((await startAssistant()).state).toBe('listening')
    await stopAssistant()
    expect(assistantStatus().state).toBe('off')
    expect((await startAssistant()).state).toBe('listening')
  })

  it('two overlapping starts do not leave a false "in use" error', async () => {
    const [a, b] = await Promise.all([startAssistant(), startAssistant()])
    expect(a.state).not.toBe('error')
    expect(b.state).not.toBe('error')
    expect(assistantStatus().state).toBe('listening')
    expect(await callPipe(pipePath(), 'get_timeline', {})).toEqual([])
  })

  it('a start queued behind a stop that is draining an in-flight call still listens', async () => {
    await startAssistant()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const handlerEntered = new Promise<void>((resolve) => (entered = resolve))
    vi.mocked(handleTool).mockImplementation(async () => {
      entered()
      await held
      return []
    })
    const inFlight = callPipe(pipePath(), 'export_video', {})
    await handlerEntered

    const stopped = stopAssistant() // cannot finish while the call is open
    const restarted = startAssistant() // settings still say enabled
    release()
    await inFlight
    await stopped
    expect((await restarted).state).toBe('listening')
    expect(assistantStatus().state).toBe('listening')
  })

  it('reports an error instead of throwing when starting fails', async () => {
    settings.failure = new Error('settings unreadable')
    const status = await startAssistant()
    expect(status.state).toBe('error')
    expect(status.message).toBe('settings unreadable')
    expect(assistantStatus().state).toBe('error')
  })
})
