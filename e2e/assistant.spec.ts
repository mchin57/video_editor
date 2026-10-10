/**
 * The AI assistant end to end, driven the way Claude Code drives it: the SDK's
 * stdio client launches the built reel-mcp (out/main/mcp.js), which talks to
 * the running app over its named pipe. ARRANGE via store / files, ACT via MCP
 * calls and real clicks, ASSERT on store + DOM + files.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test, expect } from './fixtures'

const ROOT = resolve(__dirname, '..')
const MCP = join(ROOT, 'out', 'main', 'mcp.js')
const BIN = join(ROOT, 'resources', 'bin', 'ffmpeg')
const FFMPEG = join(BIN, 'ffmpeg.exe')
const FFPROBE = join(BIN, 'ffprobe.exe')
const TOOLS = ['export_video', 'get_frames', 'get_timeline', 'get_transcript', 'import_media', 'list_media', 'place_sequence', 'remove_items', 'request_feature', 'undo']

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
const textOf = (r: ToolResult): string => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

const pipeOf = (app: ElectronApplication): Promise<string> => app.evaluate(() => process.env.REEL_ASSISTANT_PIPE as string)

// Every client connect() makes is closed in afterEach, so a failed assertion
// can never leave a `node out/main/mcp.js` child alive for the rest of the run.
const clients: Client[] = []

test.afterEach(async () => {
  const open = clients.splice(0)
  await Promise.all(open.map((c) => c.close().catch(() => undefined)))
})

async function connect(pipe: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1' })
  clients.push(client) // before connect, so a failed handshake is cleaned up too
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      env: { ...getDefaultEnvironment(), REEL_ASSISTANT_PIPE: pipe },
      stderr: 'pipe'
    })
  )
  return client
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await c.callTool({ name, arguments: args })) as ToolResult

test('lists the tools; an unknown media id on an empty library says to import first', async ({ electronApp, appPage: _page }) => {
  const c = await connect(await pipeOf(electronApp))
  expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS)
  const r = await call(c, 'get_transcript', { mediaId: 'nope' })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toMatch(/No media "nope".*Valid ids.*the library is empty/s)
  // (that valid ids are actually NAMED is pinned in the rough-cut test, where the library has media)
})

test('says plainly when the editor is not running', async () => {
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\reel-nobody-home' : join(tmpdir(), 'reel-nobody-home.sock')
  const c = await connect(pipe)
  const r = await call(c, 'list_media')
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain("Reel Editor isn't running")
})

test('files a feature request into the TODO list once', async ({ electronApp, appPage: _page }) => {
  const todo = await electronApp.evaluate(() => process.env.REEL_TODO_PATH as string)
  writeFileSync(todo, '# TODO\n\n## Open\n\n- [ ] x\n')
  const c = await connect(await pipeOf(electronApp))
  const req = { title: 'Beat snap', problem: 'Wanted cuts on the beat of the music.', proposal: 'detect_beats tool' }
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Filed in/)
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Already requested/)
  expect(readFileSync(todo, 'utf8')).toMatch(
    /## Assistant requests\n\n- \[ \] \*\*Beat snap\*\* — Wanted cuts on the beat of the music\. _Proposal:_ detect_beats tool _\(requested by assistant, \d{4}-\d{2}-\d{2}\)_\n\n## Open/
  )
})

test('the Settings toggle disconnects and reconnects Claude Code', async ({ electronApp, appPage: page }) => {
  const c = await connect(await pipeOf(electronApp))
  await page.evaluate(() => window.__reelStores.useUi.getState().setSettingsOpen(true))
  const toggle = page.getByLabel('Let Claude Code control the editor')
  await expect(toggle).toBeChecked()
  await expect(page.getByTestId('assistant-status')).toHaveText('Listening for Claude Code')

  await toggle.click()
  await expect(page.getByTestId('assistant-status')).toHaveText('Off')
  const off = await call(c, 'get_timeline')
  expect(off.isError).toBe(true)
  expect(textOf(off)).toContain("Reel Editor isn't running")

  await toggle.click()
  await expect(page.getByTestId('assistant-status')).toHaveText('Listening for Claude Code')
  expect((await call(c, 'get_timeline')).isError).toBeFalsy()
})

test('rough cut in the given order, undone in one step, then exported', async ({ electronApp, appPage: page }) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(240_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const clip = (name: string, color: string): string => {
    const out = join(dir, name)
    execFileSync(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=540x960:r=30:d=4`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out
    ])
    return out
  }
  const a = clip('a.mp4', 'red')
  const b = clip('b.mp4', 'blue')
  const c = await connect(await pipeOf(electronApp))

  const imported = JSON.parse(textOf(await call(c, 'import_media', { paths: [a, b] }))) as { id: string; fileName: string }[]
  const idOf = (f: string): string => imported.find((x) => x.fileName === f)!.id
  const [A, B] = [idOf('a.mp4'), idOf('b.mp4')]

  // With media in the library, an unknown id's error must NAME the valid ids.
  const bad = await call(c, 'get_transcript', { mediaId: 'nope' })
  expect(bad.isError).toBe(true)
  expect(textOf(bad)).toContain('Valid ids')
  expect(textOf(bad)).toContain(A)
  expect(textOf(bad)).toContain(B)

  const frames = await call(c, 'get_frames', { mediaId: A, count: 2 })
  expect(frames.isError).toBeFalsy()
  const images = frames.content.filter((x) => x.type === 'image')
  expect(images).toHaveLength(2)
  expect(images.every((x) => x.mimeType === 'image/jpeg' && (x.data?.length ?? 0) > 100)).toBe(true)

  const historyBefore = await page.evaluate(() => window.__reelStores.useProject.getState().past.length)
  const placed = await call(c, 'place_sequence', {
    items: [{ mediaId: B, inSec: 1, outSec: 3 }, { mediaId: A, inSec: 0.5, outSec: 2 }]
  })
  expect(placed.isError).toBeFalsy()

  const layers = await page.evaluate(() =>
    window.__reelStores.useProject.getState().project!.layers.map((l) => ({
      id: l.id,
      mediaId: (l.content as { mediaId?: string }).mediaId,
      startSec: l.startSec,
      endSec: l.endSec
    }))
  )
  expect(layers.map((l) => l.mediaId)).toEqual([B, A])
  expect(layers[0].startSec).toBeCloseTo(0, 6)
  expect(layers[0].endSec).toBeCloseTo(2, 6)
  expect(layers[1].startSec).toBeCloseTo(2, 6)
  expect(layers[1].endSec).toBeCloseTo(3.5, 6)
  for (const l of layers) await expect(page.getByTestId(`tile-layer-${l.id}`)).toBeVisible()
  // Timeline DOM in the given order: B was placed first, so its tile sits left of A's.
  const tileX = async (id: string): Promise<number> => (await page.getByTestId(`tile-layer-${id}`).boundingBox())!.x
  expect(await tileX(layers[0].id)).toBeLessThan(await tileX(layers[1].id))
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.audioClips.length)).toBe(2)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().past.length)).toBe(historyBefore + 1)

  const undone = JSON.parse(textOf(await call(c, 'undo'))) as { undone: boolean; timeline: { layers: unknown[] } }
  expect(undone.undone).toBe(true)
  expect(undone.timeline.layers).toEqual([])

  await call(c, 'place_sequence', { items: [{ mediaId: B, inSec: 1, outSec: 3 }, { mediaId: A, inSec: 0.5, outSec: 2 }] })
  const first = JSON.parse(textOf(await call(c, 'export_video', { fileName: 'cut' }))) as { path: string }
  const second = JSON.parse(textOf(await call(c, 'export_video', { fileName: 'cut' }))) as { path: string }
  expect(first.path).toMatch(/[\\/]cut\.mp4$/)
  expect(second.path).toMatch(/[\\/]cut \(2\)\.mp4$/)
  const duration = Number(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', first.path]).toString().trim()
  )
  expect(duration).toBeGreaterThan(3.4)
  expect(duration).toBeLessThan(3.7)
})
