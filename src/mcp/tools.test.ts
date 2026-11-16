// @vitest-environment node
/**
 * reel-mcp's argument schemas, exercised the way Claude Code reaches them: a
 * real McpServer with these tools, a real MCP client over an in-memory
 * transport. A refused call must come back as a tool error and never reach the
 * editor (`call`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  GRADIENT_ANGLE_MAX,
  TEXT_MAX_CHARS,
  TEXT_ROTATION_MAX_DEG,
  TEXT_X_MAX,
  TEXT_Y_MIN
} from '@shared/assistant/onScreenText'
import { MAX_TIME_SEC, registerTools, type CallEditor } from './tools'

let client: Client
let call: ReturnType<typeof vi.fn>

beforeEach(async () => {
  call = vi.fn(async () => [{ type: 'text' as const, text: 'ok' }])
  const server = new McpServer({ name: 'reel-editor-test', version: '0' })
  registerTools(server, call as unknown as CallEditor)
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
})

afterEach(async () => {
  await client.close()
})

/** The text of a call's result, and whether it was an error. */
async function run(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: { type: string; text?: string }[]
  }
  return { isError: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n') }
}

const NUL = String.fromCharCode(0)

describe('time arguments (#11: "Infinitys")', () => {
  it('refuses Infinity (what a JSON 1e309 parses to) without calling the editor', async () => {
    expect(JSON.parse('1e309')).toBe(Infinity)
    for (const [tool, args] of [
      ['split_clip', { mediaId: 'm', times: [Infinity] }],
      ['render_frame', { times: [Infinity] }]
    ] as const) {
      const r = await run(tool, args)
      expect(r.isError, tool).toBe(true)
      expect(r.text).not.toMatch(/Infinitys/)
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a finite-but-huge time with a readable limit instead', async () => {
    for (const [tool, args] of [
      ['split_clip', { mediaId: 'm', times: [1e308] }],
      ['render_frame', { times: [1e308] }],
      ['set_playhead', { timeSec: 1e308 }],
      ['get_transcript', { mediaId: 'm', toSec: 1e308 }],
      ['place_sequence', { items: [{ mediaId: 'm', inSec: 0, outSec: 1e308 }] }],
      ['set_text', { edits: [{ text: 'hi', startSec: 0, endSec: 1e308 }] }]
    ] as const) {
      const r = await run(tool, args)
      expect(r.isError, tool).toBe(true)
      expect(r.text, tool).toContain(String(MAX_TIME_SEC))
      expect(r.text, tool).not.toMatch(/Infinity/)
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('passes ordinary times through', async () => {
    expect((await run('render_frame', { times: [0, 2.5] })).isError).toBe(false)
    expect(call).toHaveBeenCalledWith('render_frame', { times: [0, 2.5] })
  })

  it('place_sequence takes the three modes and refuses any other', async () => {
    const items = [{ mediaId: 'm', inSec: 0, outSec: 1 }]
    for (const mode of ['append', 'replace', 'insert']) {
      expect((await run('place_sequence', { items, mode, atSec: 2 })).isError, mode).toBe(false)
      expect(call).toHaveBeenCalledWith('place_sequence', { items, mode, atSec: 2 })
    }
    call.mockClear()
    expect((await run('place_sequence', { items, mode: 'ripple' })).isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('set_text bounds (#10)', () => {
  const edit = (e: Record<string, unknown>): Promise<{ isError: boolean; text: string }> =>
    run('set_text', { edits: [{ id: 't1', ...e }] })

  it('refuses extreme position, rotation and gradient angle', async () => {
    for (const e of [
      { x: 1e308 },
      { x: TEXT_X_MAX + 1 },
      { y: -1e308 },
      { y: TEXT_Y_MIN - 1 },
      { rotationDeg: 1e308 },
      { rotationDeg: -TEXT_ROTATION_MAX_DEG - 1 },
      { gradient: { from: '#ffffff', to: '#000000', angle: 1e308 } },
      { gradient: { from: '#ffffff', to: '#000000', angle: GRADIENT_ANGLE_MAX + 1 } }
    ]) {
      expect((await edit(e)).isError, JSON.stringify(e)).toBe(true)
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses text over the cap and text holding a NUL', async () => {
    expect((await edit({ text: 'a'.repeat(TEXT_MAX_CHARS + 1) })).isError).toBe(true)
    const nul = await edit({ text: `a${NUL}b` })
    expect(nul.isError).toBe(true)
    expect(nul.text).toMatch(/control characters/)
    expect(call).not.toHaveBeenCalled()
  })

  it('accepts in-range values, a capped-length text, newlines and tabs', async () => {
    const text = `${'a'.repeat(TEXT_MAX_CHARS - 2)}\n\t`
    const r = await edit({ text, x: TEXT_X_MAX, y: TEXT_Y_MIN, rotationDeg: TEXT_ROTATION_MAX_DEG })
    expect(r.isError).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('set_transition (#64)', () => {
  it('takes a side, a kind and an optional length in range, and forwards them as given', async () => {
    for (const kind of ['dissolve', 'dipBlack', 'dipWhite', 'fade', 'none']) {
      expect((await run('set_transition', { id: 'L', side: 'out', kind })).isError, kind).toBe(false)
      expect(call).toHaveBeenLastCalledWith('set_transition', { id: 'L', side: 'out', kind })
    }
    expect((await run('set_transition', { id: 'L', side: 'in', kind: 'dissolve', sec: 1.5 })).isError).toBe(false)
    expect(call).toHaveBeenLastCalledWith('set_transition', { id: 'L', side: 'in', kind: 'dissolve', sec: 1.5 })
  })

  it('refuses an unknown kind or side, and a length outside 0.1–2 s, without calling the editor', async () => {
    call.mockClear()
    for (const args of [
      { id: 'L', side: 'in', kind: 'wipe' },
      { id: 'L', side: 'middle', kind: 'fade' },
      { id: 'L', side: 'in', kind: 'fade', sec: 0 },
      { id: 'L', side: 'in', kind: 'fade', sec: 5 }
    ]) {
      expect((await run('set_transition', args)).isError, JSON.stringify(args)).toBe(true)
    }
    expect(call).not.toHaveBeenCalled()
  })
})
