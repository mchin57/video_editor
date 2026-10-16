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
import type { ElectronApplication, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test, expect } from './fixtures'

const ROOT = resolve(__dirname, '..')
const MCP = join(ROOT, 'out', 'main', 'mcp.js')
const BIN = join(ROOT, 'resources', 'bin', 'ffmpeg')
const FFMPEG = join(BIN, 'ffmpeg.exe')
const FFPROBE = join(BIN, 'ffprobe.exe')
const TOOLS = ['add_description', 'export_video', 'get_frames', 'get_text', 'get_timeline', 'get_transcript', 'import_media', 'list_media', 'place_sequence', 'remove_items', 'render_frame', 'request_feature', 'set_playhead', 'set_text', 'split_clip', 'trim_clip', 'undo']

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

test('files a feature request as an issue once', async ({ electronApp, appPage: _page }) => {
  const sink = await electronApp.evaluate(() => process.env.REEL_ISSUES_SINK as string)
  const c = await connect(await pipeOf(electronApp))
  const req = { title: 'Beat snap', problem: 'Wanted cuts on the beat of the music.', proposal: 'detect_beats tool' }
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Filed as a GitHub issue/)
  expect(textOf(await call(c, 'request_feature', req))).toMatch(/^Already requested/)
  const rows = readFileSync(sink, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  expect(rows).toHaveLength(1)
  expect(rows[0].title).toBe('Beat snap')
  expect(rows[0].labels).toEqual(['enhancement', 'assistant'])
  expect(rows[0].body).toContain('**Proposal.** detect_beats tool')
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

test('split_clip and trim_clip save new clips to generated/ and the library; bad times change nothing', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const src = join(dir, 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src
  ])
  const c = await connect(await pipeOf(electronApp))
  const { imported } = JSON.parse(textOf(await call(c, 'import_media', { paths: [src] }))) as { imported: { id: string }[] }
  const id = imported[0].id
  const mediaIds = (): Promise<string[]> => page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)
  const probeDur = (f: string): number =>
    Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())
  type Created = { id: string; fileName: string; path: string; durationSec: number; fromSourceSec: [number, number] }

  // Refused before any encode: nothing is added.
  const before = await mediaIds()
  expect(textOf(await call(c, 'split_clip', { mediaId: id, times: [9] }))).toContain('not inside the clip')
  expect(textOf(await call(c, 'split_clip', { mediaId: id, times: [1, 1.05] }))).toContain('shorter than 0.1s')
  expect(textOf(await call(c, 'trim_clip', { mediaId: id, startSec: 3, endSec: 2 }))).toContain('must be after the start')
  expect(await mediaIds()).toEqual(before)

  // Split at two points (any order) → three back-to-back clips, in order.
  const split = await call(c, 'split_clip', { mediaId: id, times: [2.5, 1] })
  expect(split.isError).toBeFalsy()
  const parts = (JSON.parse(textOf(split)) as { created: Created[] }).created
  expect(parts.map((p) => p.fileName)).toEqual(['clip (cut 1).mp4', 'clip (cut 2).mp4', 'clip (cut 3).mp4'])
  expect(parts.map((p) => p.fromSourceSec)).toEqual([[0, 1], [1, 2.5], [2.5, 4]])
  const generated = join(projectsDir, 'E2E', 'generated')
  for (const [i, want] of [1, 1.5, 1.5].entries()) {
    expect(parts[i].path).toBe(join(generated, parts[i].fileName))
    expect(probeDur(parts[i].path)).toBeCloseTo(want, 1)
  }

  // Trim keeps one window; an end past the clip is clamped.
  const trim = JSON.parse(textOf(await call(c, 'trim_clip', { mediaId: id, startSec: 0.5, endSec: 99 }))) as { created: Created[] }
  expect(trim.created.map((p) => [p.fileName, p.fromSourceSec])).toEqual([['clip (cut).mp4', [0.5, 4]]])
  expect(probeDur(trim.created[0].path)).toBeCloseTo(3.5, 1)

  // All four are in the project's library; the original stays, and the edit is untouched.
  const now = await mediaIds()
  expect(now).toEqual(expect.arrayContaining([id, ...parts.map((p) => p.id), trim.created[0].id]))
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)).toBe(0)
})

test('add_description sets, shows and clears a clip description; list_media returns it', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const c = await connect(await pipeOf(electronApp))
  const { imported } = JSON.parse(textOf(await call(c, 'import_media', { paths: [blackClip(dir)] }))) as { imported: { id: string }[] }
  const id = imported[0].id
  type Listed = { id: string; description?: string }[]
  const listed = async (): Promise<Listed> => JSON.parse(textOf(await call(c, 'list_media'))) as Listed

  expect(textOf(await call(c, 'add_description', { mediaId: id, description: '  Night run, streetlights  ' }))).toBe(
    'Description saved for black.mp4.'
  )
  expect((await listed())[0].description).toBe('Night run, streetlights')
  // The editor's library shows it (and the change is unsaved until Save).
  await expect
    .poll(() => page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0].description, id))
    .toBe('Night run, streetlights')
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().dirty)).toBe(true)

  expect(textOf(await call(c, 'add_description', { mediaId: id, description: '' }))).toBe('Description removed from black.mp4.')
  expect((await listed())[0]).not.toHaveProperty('description')

  const bad = await call(c, 'add_description', { mediaId: 'nope', description: 'x' })
  expect(bad.isError).toBe(true)
  expect(textOf(bad)).toContain(`Valid ids: ${id}`)
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

// --- On-screen text: get_text / set_text / set_playhead -----------------------

/** A text layer "t1" (0–3 s) and a caption "c1" (2–4 s, "helo wrld") with word timings. */
async function seedText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.addLayer({
      id: 't1',
      hidden: false,
      startSec: 0,
      endSec: 3,
      x: 540,
      y: 600,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Helo there',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 76,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    const captions = window.__reelStores.useProject.getState().project!.captions
    s.setCaptions({
      ...captions,
      enabled: true,
      segments: [
        {
          id: 'c1',
          startSec: 2,
          endSec: 4,
          text: 'helo wrld',
          words: [
            { text: 'helo', startSec: 2, endSec: 2.8 },
            { text: 'wrld', startSec: 3, endSec: 3.8 }
          ],
          enabled: true
        }
      ]
    })
  })
}

type TextState = { past: number; layers: { id: string; text?: string; color?: string }[]; captions: { id: string; text: string }[] }
const textState = (page: Page): Promise<TextState> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const p = s.project!
    return {
      past: s.past.length,
      layers: p.layers.map((l) =>
        l.content.kind === 'text' ? { id: l.id, text: l.content.text, color: l.content.color } : { id: l.id }
      ),
      captions: p.captions.segments.map((c) => ({ id: c.id, text: c.text }))
    }
  })

/** An MCP call that may be refused by schema validation (thrown) or by the editor (isError). */
async function refusal(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await call(c, name, args)
    expect(r.isError).toBe(true)
    return textOf(r)
  } catch (e) {
    return (e as Error).message
  }
}

test('get_text lists text layers and captions; set_text creates and fixes them in one undo step', async ({
  electronApp,
  appPage: page
}) => {
  await seedText(page)
  const c = await connect(await pipeOf(electronApp))

  const listed = JSON.parse(textOf(await call(c, 'get_text'))) as {
    captionLane: { id: string; visible: boolean }
    items: { id: string; kind: string; text: string; styleFrom?: string; visible: boolean }[]
  }
  expect(listed.captionLane).toMatchObject({ id: 'captions', visible: true })
  expect(listed.items.map((i) => [i.id, i.kind, i.text])).toEqual([
    ['t1', 'text', 'Helo there'],
    ['c1', 'caption', 'helo wrld']
  ])
  expect(listed.items[1].styleFrom).toBe('lane')
  // What is on screen at 1 s: only the title.
  const at1 = JSON.parse(textOf(await call(c, 'get_text', { fromSec: 1, toSec: 1 }))) as { items: { id: string }[] }
  expect(at1.items.map((i) => i.id)).toEqual(['t1'])

  const before = await textState(page)
  const r = await call(c, 'set_text', {
    edits: [
      { id: 'c1', text: 'hello world' },
      { id: 't1', text: 'Hello there', color: '#ff0000' },
      { text: 'Day one', startSec: 1, endSec: 2 }
    ]
  })
  expect(r.isError).toBeFalsy()
  const { results } = JSON.parse(textOf(r)) as { results: { id: string; kind: string; created: boolean }[] }
  expect(results.map((x) => [x.kind, x.created])).toEqual([
    ['caption', false],
    ['text', false],
    ['text', true]
  ])
  const created = results[2].id
  await expect(page.getByTestId(`tile-layer-${created}`)).toBeVisible()
  const after = await textState(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.captions).toEqual([{ id: 'c1', text: 'hello world' }])
  expect(after.layers.find((l) => l.id === 't1')).toMatchObject({ text: 'Hello there', color: '#ff0000' })
  expect(after.layers.find((l) => l.id === created)).toMatchObject({ text: 'Day one' })

  // One undo reverts the whole batch.
  await call(c, 'undo')
  expect(await textState(page)).toEqual(before)
  await expect(page.getByTestId(`tile-layer-${created}`)).toHaveCount(0)
})

test('set_text refuses bad edits and changes nothing', async ({ electronApp, appPage: page }) => {
  await seedText(page)
  // Link the caption to the title so its timing is locked.
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().linkItems([
      { kind: 'layer', id: 't1' },
      { kind: 'caption', id: 'c1' }
    ])
  )
  const c = await connect(await pipeOf(electronApp))
  const before = await textState(page)

  expect(await refusal(c, 'set_text', { edits: [{ id: 't1', colour: '#ffffff' }] })).toMatch(/colour/)
  expect(await refusal(c, 'set_text', { edits: [{ id: 't1', fontFamily: 'comic-sans' }] })).toMatch(/fontFamily|comic-sans/)
  // A good edit in the same batch as a bad one is not applied either.
  const mixed = await refusal(c, 'set_text', { edits: [{ id: 't1', text: 'Fine' }, { id: 'nope', text: 'x' }] })
  expect(mixed).toMatch(/Nothing was changed[\s\S]*edit 2 \(id "nope"\): no text layer or caption has this id/)
  expect(await refusal(c, 'set_text', { edits: [{ id: 'c1', startSec: 2.5 }] })).toMatch(/linked to another timeline item/)
  expect(await refusal(c, 'set_text', { edits: [{ text: 'no window' }] })).toMatch(/needs startSec and endSec/)

  expect(await textState(page)).toEqual(before)
  // Text on a linked caption is still fine.
  expect((await call(c, 'set_text', { edits: [{ id: 'c1', text: 'hello world' }] })).isError).toBeFalsy()
})

test('a caption fixed through set_text keeps the fix when it is split', async ({ electronApp, appPage: page }) => {
  await seedText(page)
  const c = await connect(await pipeOf(electronApp))
  expect((await call(c, 'set_text', { edits: [{ id: 'c1', text: 'hello world' }] })).isError).toBeFalsy()
  await page.evaluate(() =>
    window.__reelStores.useProject.getState().splitItemsAt([{ kind: 'caption', id: 'c1' }], 2.9, () => 0)
  )
  expect((await textState(page)).captions.map((x) => x.text)).toEqual(['hello', 'world'])
})

test('set_playhead parks the playhead, paused, clamped to the edit', async ({ electronApp, appPage: page }) => {
  await seedText(page) // the edit is 3 s long: the title ends at 3 (captions do not extend it)
  const c = await connect(await pipeOf(electronApp))
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setPlaying(true))
  expect(textOf(await call(c, 'set_playhead', { timeSec: 2.5 }))).toMatch(/^Playhead at 2\.5s\. Playback is paused/)
  expect(await page.evaluate(() => window.__reelStores.usePlayback.getState())).toMatchObject({ time: 2.5, playing: false })
  expect(textOf(await call(c, 'set_playhead', { timeSec: 99 }))).toMatch(/^Playhead at 3s \(clamped; the edit is 3s long\)/)
  expect(await page.evaluate(() => window.__reelStores.usePlayback.getState().time)).toBe(3)
})

/** A 3 s black 540×960 clip, synthesized with the real ffmpeg. */
function blackClip(dir: string): string {
  const clip = join(dir, 'black.mp4')
  execFileSync(FFMPEG, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=540x960:r=30:d=3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip
  ])
  return clip
}

/** Mean luma of the caption band (the lane's default spot, centre y 1340 of 1920) of a
 *  returned JPEG, measured by the real ffmpeg. Relative crop: stills are downscaled. */
function captionLuma(dir: string, b64: string, name: string): number {
  const jpg = join(dir, name)
  writeFileSync(jpg, Buffer.from(b64, 'base64'))
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', jpg, '-vf', 'crop=iw*0.74:ih*0.083:iw*0.13:ih*0.656,format=gray', '-f', 'rawvideo', '-'])
  return raw.reduce((s, v) => s + v, 0) / raw.length
}

const images = (r: ToolResult): string[] => r.content.filter((x) => x.type === 'image').map((x) => x.data!)

test('render_frame returns the finished picture, caption burned in at the right moment', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG) || !existsSync(FFPROBE), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const c = await connect(await pipeOf(electronApp))
  const { imported } = JSON.parse(textOf(await call(c, 'import_media', { paths: [blackClip(dir)] }))) as { imported: { id: string }[] }
  expect((await call(c, 'place_sequence', { items: [{ mediaId: imported[0].id, inSec: 0, outSec: 3 }] })).isError).toBeFalsy()
  // A white caption 0–1 s, in the lane's default spot.
  expect(
    (await call(c, 'set_text', { edits: [{ id: 'captions', visible: true }, { kind: 'caption', text: 'HELLO WORLD', startSec: 0, endSec: 1 }] }))
      .isError
  ).toBeFalsy()

  const r = await call(c, 'render_frame', { times: [0.5, 2.5, 99] })
  expect(r.isError).toBeFalsy()
  expect(textOf(r)).toMatch(/Finished frame @ 0\.5s \(timeline\)\n[\s\S]*Finished frame @ 2\.5s \(timeline\)\n/)
  // Past the end: the label says which frame it really is.
  expect(textOf(r)).toContain('Finished frame @ 2.97s (timeline) — asked for 99s, which is past the end of the edit; this is its last frame')
  const [during, after] = images(r)
  expect(captionLuma(dir, during, 'during.jpg')).toBeGreaterThan(20) // white glyphs over black
  expect(captionLuma(dir, after, 'after.jpg')).toBeLessThan(5) // the caption has ended
  // Downscaled to 1280 on the long side.
  const size = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, 'during.jpg')])
    .toString()
    .trim()
  expect(size).toBe('720,1280')

  // Same moment with the lane off: the band goes dark, so it really was the caption.
  await call(c, 'set_text', { edits: [{ id: 'captions', visible: false }] })
  const off = images(await call(c, 'render_frame', { times: [0.5] }))
  expect(off).toHaveLength(1)
  expect(captionLuma(dir, off[0], 'off.jpg')).toBeLessThan(5)
  // Rendering frames is not an export: no export job appeared (it never blocks the Export button).
  const jobTypes = await page.evaluate(() => Object.values(window.__reelStores.useEditor.getState().jobs).map((j) => j.type))
  expect(jobTypes).not.toContain('export')
})

test('inside a compound clip, render_frame uses the same local times as get_text', async ({ electronApp, appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'reel-assistant-'))
  const c = await connect(await pipeOf(electronApp))
  const { imported } = JSON.parse(textOf(await call(c, 'import_media', { paths: [blackClip(dir)] }))) as { imported: { id: string }[] }
  // The clip sits at 2–5 s on the root, then becomes a compound clip the user enters.
  const { placed } = JSON.parse(
    textOf(await call(c, 'place_sequence', { items: [{ mediaId: imported[0].id, inSec: 0, outSec: 3 }], atSec: 2 }))
  ) as { placed: { layerId: string }[] }
  const layerId = placed[0].layerId
  await page.evaluate((id) => {
    const s = window.__reelStores.useProject.getState()
    s.convertLayerToComp(id)
    s.enterComposition({ layerId: id })
  }, layerId)
  // A caption at LOCAL 0–1 s (root 2–3 s).
  await call(c, 'set_text', { edits: [{ id: 'captions', visible: true }, { kind: 'caption', text: 'HELLO WORLD', startSec: 0, endSec: 1 }] })
  const listed = JSON.parse(textOf(await call(c, 'get_text'))) as { items: { text: string; startSec: number }[] }
  expect(listed.items).toEqual([expect.objectContaining({ text: 'HELLO WORLD', startSec: 0 })])

  const r = await call(c, 'render_frame', { times: [0.5] })
  expect(r.isError).toBeFalsy()
  expect(textOf(r)).toContain('inside a nested composition')
  // At local 0.5 s the caption shows (rendering the root at 0.5 s would be black: the clip starts at 2 s).
  expect(captionLuma(dir, images(r)[0], 'nested.jpg')).toBeGreaterThan(20)
})

test('a render that fails half-way does not leave its text-layout window behind', async ({ electronApp, appPage: page }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (see plan Task 1 Step 1)')
  // A gradient text layer (rasterised by the hidden Chromium window during the walk),
  // then a clip whose media isn't in the library: the render throws after the window exists.
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.addLayer({
      id: 'grad',
      hidden: false,
      startSec: 0,
      endSec: 2,
      x: 540,
      y: 600,
      scale: 1,
      content: {
        kind: 'text',
        text: 'Gradient',
        fontFamily: 'montserrat-extrabold',
        fontSizePx: 76,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 },
        gradient: { from: '#ff0000', to: '#0000ff', angle: 90 }
      }
    })
    s.addVideoLayer('ghost', 'no-such-media', 0, 2, false)
  })
  const windows = (): Promise<number> => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const before = await windows()
  const c = await connect(await pipeOf(electronApp))
  const r = await call(c, 'render_frame', { times: [0.5] })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain('Missing source media')
  await expect.poll(windows).toBe(before)
})
