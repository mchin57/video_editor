// @vitest-environment node
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IN_USE, NOT_RUNNING, callPipe, servePipe } from './pipe'

let n = 0
const uniquePipe = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\reel-test-${process.pid}-${++n}`
    : join(tmpdir(), `reel-test-${process.pid}-${++n}.sock`)

const servers: net.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function serve(path: string, handle: Parameters<typeof servePipe>[1]): Promise<void> {
  const r = await servePipe(path, handle)
  if (!r.ok) throw new Error(r.message)
  servers.push(r.server)
}

describe('servePipe + callPipe', () => {
  it('round-trips a call with text and image content', async () => {
    const path = uniquePipe()
    await serve(path, async (tool, args) => [
      { type: 'text', text: `${tool}:${JSON.stringify(args)}` },
      { type: 'image', data: Buffer.alloc(5000, 7).toString('base64'), mimeType: 'image/jpeg' }
    ])
    const content = await callPipe(path, 'get_frames', { mediaId: 'm', count: 2 })
    expect(content[0]).toEqual({ type: 'text', text: 'get_frames:{"mediaId":"m","count":2}' })
    expect(content[1].type === 'image' && Buffer.from(content[1].data, 'base64').equals(Buffer.alloc(5000, 7))).toBe(
      true
    )
  })

  it("passes a handler's error back as the call's error", async () => {
    const path = uniquePipe()
    await serve(path, async () => {
      throw new Error('No media "x" in this project')
    })
    await expect(callPipe(path, 'get_transcript', {})).rejects.toThrow('No media "x" in this project')
  })

  it('says plainly when nothing is serving the pipe', async () => {
    await expect(callPipe(uniquePipe(), 'list_media', {})).rejects.toThrow(NOT_RUNNING)
  })

  it('answers two concurrent calls independently', async () => {
    const path = uniquePipe()
    await serve(path, async (tool) => {
      await new Promise((r) => setTimeout(r, tool === 'slow' ? 200 : 10))
      return [{ type: 'text', text: tool }]
    })
    const [slow, fast] = await Promise.all([callPipe(path, 'slow', {}), callPipe(path, 'fast', {})])
    expect(slow).toEqual([{ type: 'text', text: 'slow' }])
    expect(fast).toEqual([{ type: 'text', text: 'fast' }])
  })

  it('reports a pipe that another editor already serves', async () => {
    const path = uniquePipe()
    await serve(path, async () => [])
    expect(await servePipe(path, async () => [])).toEqual({ ok: false, message: IN_USE })
  })

  it('reports an editor that hangs up without answering', async () => {
    const path = uniquePipe()
    const rude = net.createServer((sock) => sock.destroy())
    await new Promise<void>((r) => rude.listen(path, r))
    servers.push(rude)
    await expect(callPipe(path, 'list_media', {})).rejects.toThrow(/closed the connection before answering/)
  })
})

describe('malformed traffic', () => {
  it('answers a line that is not a request with an error, hangs up, and keeps serving', async () => {
    const path = uniquePipe()
    await serve(path, async () => [{ type: 'text', text: 'still here' }])
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(path)
      let got = ''
      sock.setEncoding('utf8')
      sock.on('connect', () => sock.write('null\n'))
      sock.on('data', (chunk: string) => (got += chunk))
      sock.on('error', reject)
      sock.on('close', () => resolve(got))
    })
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false })
    expect(await callPipe(path, 'list_media', {})).toEqual([{ type: 'text', text: 'still here' }])
  }, 5000)

  it('fails the call, rather than hanging, when the handler returns content that cannot be encoded', async () => {
    const path = uniquePipe()
    // JSON.stringify throws on a BigInt; the cast stands in for a handler bug.
    await serve(path, async () => [{ type: 'text', text: 'x', big: 1n } as never])
    await expect(callPipe(path, 'list_media', {})).rejects.toThrow(/could not be sent/)
  }, 5000)

  it('rejects, rather than throwing, when the editor answers with a non-object line', async () => {
    const path = uniquePipe()
    const odd = net.createServer((sock) => sock.once('data', () => sock.end('null\n')))
    await new Promise<void>((r) => odd.listen(path, r))
    servers.push(odd)
    await expect(callPipe(path, 'list_media', {})).rejects.toThrow(/malformed answer/)
  }, 5000)
})
