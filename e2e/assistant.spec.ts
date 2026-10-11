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

  const relative = await call(c, 'import_media', { paths: ['a.mp4'] })
  expect(relative.isError).toBe(true)
  expect(textOf(relative)).toContain('Paths must be absolute: a.mp4')

  const missing = join(dir, 'missing.mp4')
  const { imported, skipped } = JSON.parse(textOf(await call(c, 'import_media', { paths: [a, missing, b] }))) as {
    imported: { id: string; fileName: string }[]
    skipped: { path: string; reason: string }[]
  }
  expect(imported.map((x) => x.fileName)).toEqual(['a.mp4', 'b.mp4'])
  expect(skipped.map((s) => s.path)).toEqual([missing])
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

  // A requested folder: must be absolute and exist; the file lands there, not in Settings' folder.
  const notThere = await call(c, 'export_video', { fileName: 'cut', folder: join(dir, 'nope') })
  expect(notThere.isError).toBe(true)
  expect(textOf(notThere)).toContain('No folder at')
  expect((await call(c, 'export_video', { fileName: 'cut', folder: 'out' })).isError).toBe(true)
  const there = JSON.parse(textOf(await call(c, 'export_video', { fileName: 'cut', folder: dir }))) as { path: string }
  expect(there.path).toBe(join(dir, 'cut.mp4'))
  expect(existsSync(there.path)).toBe(true)
})

test('an edit that arrives mid-drag waits for the release instead of being overwritten', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const clip = join(dir, 'a.mp4')
  execFileSync(FFMPEG, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=540x960:r=30:d=3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip
  ])
  const c = await connect(await pipeOf(electronApp))
  const { imported } = JSON.parse(textOf(await call(c, 'import_media', { paths: [clip] }))) as { imported: { id: string }[] }
  const item = { mediaId: imported[0].id, inSec: 0, outSec: 1 }
  expect((await call(c, 'place_sequence', { items: [item] })).isError).toBeFalsy()
  const state = (): Promise<{ layers: { id: string; startSec: number }[]; past: number }> =>
    page.evaluate(() => {
      const s = window.__reelStores.useProject.getState()
      return { layers: s.project!.layers.map((l) => ({ id: l.id, startSec: l.startSec })), past: s.past.length }
    })
  const start = await state()
  const dragged = start.layers[0].id
  const box = (await page.getByTestId(`tile-layer-${dragged}`).boundingBox())!

  // 1. A real move drag is held while place_sequence arrives: the cut waits.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 })
  const pending = call(c, 'place_sequence', { items: [item] })
  await page.waitForTimeout(700)
  expect((await state()).layers).toHaveLength(1) // not applied mid-drag
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  const placed = await pending
  expect(placed.isError).toBeFalsy()

  const after = await state()
  const moved = after.layers.find((l) => l.id === dragged)!
  expect(moved.startSec).toBeGreaterThan(0) // the drag survived…
  expect(after.layers).toHaveLength(2) // …and so did the cut, after it
  expect(after.past).toBe(start.past + 2) // two undo steps, drag first
  await call(c, 'undo') // undoes only the cut
  const undone = await state()
  expect(undone.layers.map((l) => l.id)).toEqual([dragged])
  expect(undone.layers[0].startSec).toBeCloseTo(moved.startSec, 6)

  // 2. Pressed but not yet moved (inside the click slop): the drag's snapshot is already
  //    taken, so a removal must still wait for the release.
  const box2 = (await page.getByTestId(`tile-layer-${dragged}`).boundingBox())!
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
  await page.mouse.down()
  const removing = call(c, 'remove_items', { ids: [dragged] })
  await page.waitForTimeout(700)
  expect((await state()).layers).toHaveLength(1)
  await page.mouse.up()
  expect((await removing).isError).toBeFalsy()
  expect((await state()).layers).toHaveLength(0)
})

test('an edit that reaches a blocked editor after the timeout is dropped, not applied late', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const clip = join(dir, 'a.mp4')
  execFileSync(FFMPEG, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=540x960:r=30:d=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip
  ])
  const c = await connect(await pipeOf(electronApp))
  const { imported } = JSON.parse(textOf(await call(c, 'import_media', { paths: [clip] }))) as { imported: { id: string }[] }
  expect((await call(c, 'place_sequence', { items: [{ mediaId: imported[0].id, inSec: 0, outSec: 1 }] })).isError).toBeFalsy()
  const before = await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return { layerIds: s.project!.layers.map((l) => l.id), past: s.past.length }
  })
  expect(before.layerIds).toHaveLength(1)

  // Block the renderer's main thread past main's 10 s timeout, like a window.confirm would.
  // Scheduled from a timer so this evaluate returns before the loop starts.
  await page.evaluate(() => {
    setTimeout(() => {
      const until = Date.now() + 11_500
      while (Date.now() < until) {
        /* busy */
      }
    }, 0)
  })
  // remove_items is a single edit op to the renderer (no read first), so it is the request that waits.
  const late = await call(c, 'remove_items', { ids: before.layerIds })
  expect(late.isError).toBe(true)
  expect(textOf(late)).toContain('did not answer')

  // This evaluate runs only once the loop ends, and the queued removal is delivered first. It must not have run.
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return { layerIds: s.project!.layers.map((l) => l.id), past: s.past.length }
  })
  expect(after).toEqual(before)
})
