/**
 * A finished export saves the project — the store's `save`, exactly File > Save —
 * from both the Export button and the assistant's `export_video`. A blocked
 * (missing media), failed or canceled export saves nothing: the `.reel` stays
 * byte-identical. Every native dialog is stubbed; nothing waits on a person.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'

const ROOT = resolve(__dirname, '..')
const MCP = join(ROOT, 'out', 'main', 'mcp.js')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean }
const textOf = (r: ToolResult): string => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

// Every MCP client is closed in afterEach, so a failed assertion never leaves reel-mcp running.
const clients: Client[] = []
test.afterEach(async () => {
  const open = clients.splice(0)
  await Promise.all(open.map((c) => c.close().catch(() => undefined)))
})

async function connect(app: ElectronApplication): Promise<Client> {
  const pipe = await app.evaluate(() => process.env.REEL_ASSISTANT_PIPE as string)
  const client = new Client({ name: 'e2e', version: '1' })
  clients.push(client)
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

interface Arranged {
  reel: string
  source: string
  /** The .reel's bytes after the baseline save (before the unsaved edit). */
  saved: Buffer
}

/**
 * A 2 s clip imported into the project's folder, placed, proxied and SAVED; then
 * one unsaved edit (preset → square) so a save would visibly change the .reel.
 */
async function arrange(page: Page, projectsDir: string): Promise<Arranged> {
  const root = join(projectsDir, 'E2E')
  const source = join(root, 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    source
  ])
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const s = window.__reelStores.useProject.getState()
    s.addMedia([asset.id])
    s.addVideoLayer('v1', asset.id, 0, asset.probe.durationSec, false)
    return asset.id
  }, source)
  await expect
    .poll(async () => (await page.evaluate((i) => window.api.listProjectMedia([i]), id) as MediaAsset[])[0]?.proxyReady, {
      timeout: 30_000
    })
    .toBe(true)
  await page.evaluate(() => window.__reelStores.useProject.getState().save())
  const reel = await page.evaluate(() => window.__reelStores.useProject.getState().filePath!)
  expect(reel).toBe(join(root, 'E2E.reel'))
  expect(JSON.parse(readFileSync(reel, 'utf8')).preset ?? 'reel').toBe('reel')

  await page.evaluate(() => window.__reelStores.useProject.getState().setPreset('square'))
  expect(await dirty(page)).toBe(true)
  return { reel, source, saved: readFileSync(reel) }
}

const dirty = (page: Page): Promise<boolean> => page.evaluate(() => window.__reelStores.useProject.getState().dirty)

/** Answer main's Save dialog with `filePath` (null = cancel), recording each call in `globalThis.__asked`. */
async function stubSaveDialog(app: ElectronApplication, filePath: string | null): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    const g = globalThis as unknown as { __asked: number }
    g.__asked = 0
    dialog.showSaveDialog = (async () => {
      g.__asked++
      return filePath ? { canceled: false, filePath } : { canceled: true, filePath: '' }
    }) as typeof dialog.showSaveDialog
  }, filePath)
}

const asked = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as unknown as { __asked: number }).__asked)

const exportButton = (page: Page): ReturnType<Page['getByRole']> => page.getByRole('button', { name: 'Export', exact: true })

test('assistant export_video saves the project: the .reel holds the edit and nothing is dirty', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { reel } = await arrange(page, projectsDir)
  const c = await connect(electronApp)
  const out = mkdtempSync(join(tmpdir(), 'reel-export-save-'))

  const r = await call(c, 'export_video', { fileName: 'cut', folder: out })
  expect(r.isError, textOf(r)).toBeFalsy()
  const res = JSON.parse(textOf(r)) as { path: string; saved?: boolean; saveError?: string }
  expect(res.path).toBe(join(out, 'cut.mp4'))
  expect(existsSync(res.path)).toBe(true)
  expect(res.saved).toBe(true)
  expect(res.saveError).toBeUndefined()

  expect(JSON.parse(readFileSync(reel, 'utf8')).preset).toBe('square')
  expect(await dirty(page)).toBe(false)
})

test('the Export button saves the project after the export finishes', async ({ electronApp, appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { reel } = await arrange(page, projectsDir)
  const target = join(mkdtempSync(join(tmpdir(), 'reel-export-save-')), 'button.mp4')
  await stubSaveDialog(electronApp, target)

  await exportButton(page).click()
  await expect(page.getByRole('button', { name: '✓ Reveal export' })).toBeVisible({ timeout: 90_000 })
  expect(await asked(electronApp)).toBe(1)
  expect(existsSync(target)).toBe(true)
  await expect.poll(() => dirty(page)).toBe(false)
  expect(JSON.parse(readFileSync(reel, 'utf8')).preset).toBe('square')
  await expect(page.getByTestId('export-save-error')).toHaveCount(0)
})

test('an export blocked by missing media saves nothing (button and assistant)', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { reel, source, saved } = await arrange(page, projectsDir)
  renameSync(source, `${source}.gone`)
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-missing')).toBeVisible()

  const out = mkdtempSync(join(tmpdir(), 'reel-export-save-'))
  await stubSaveDialog(electronApp, join(out, 'blocked.mp4'))
  await exportButton(page).click()
  await expect(page.getByText(/^Export failed:/)).toBeVisible({ timeout: 30_000 })
  expect(await asked(electronApp)).toBe(1)
  expect(readFileSync(reel).equals(saved)).toBe(true)
  expect(await dirty(page)).toBe(true)

  const c = await connect(electronApp)
  const r = await call(c, 'export_video', { fileName: 'blocked', folder: out })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain('clip.mp4')
  expect(readFileSync(reel).equals(saved)).toBe(true)
  expect(await dirty(page)).toBe(true)
})

test('a canceled Save dialog exports and saves nothing', async ({ electronApp, appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { reel, saved } = await arrange(page, projectsDir)
  await stubSaveDialog(electronApp, null)

  await exportButton(page).click()
  await expect.poll(() => asked(electronApp)).toBe(1)
  await expect(exportButton(page)).toBeEnabled()
  await page.waitForTimeout(500) // a save would have been issued right after the dialog answered
  await expect(page.getByRole('button', { name: '✓ Reveal export' })).toHaveCount(0)
  expect(readFileSync(reel).equals(saved)).toBe(true)
  expect(await dirty(page)).toBe(true)
})

/**
 * Open another project (a real store action, no dialog) the moment the export
 * job appears, so the export finishes with a DIFFERENT project open.
 */
async function switchProjectWhenExportStarts(page: Page, projectsDir: string): Promise<void> {
  await page.evaluate((dir) => {
    const { useEditor, useProject } = window.__reelStores
    const off = useEditor.subscribe((s) => {
      if (!Object.values(s.jobs).some((j) => j.type === 'export')) return
      off()
      void useProject.getState().createProject('Other', dir)
    })
  }, projectsDir)
}

const otherOpen = async (page: Page, projectsDir: string): Promise<string> => {
  const other = join(projectsDir, 'Other', 'Other.reel')
  await expect.poll(() => page.evaluate(() => window.__reelStores.useProject.getState().filePath)).toBe(other)
  return other
}

test('the Export button does not save a project opened while it exported', async ({ electronApp, appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { reel, saved } = await arrange(page, projectsDir)
  const target = join(mkdtempSync(join(tmpdir(), 'reel-export-save-')), 'switch.mp4')
  await stubSaveDialog(electronApp, target)
  await switchProjectWhenExportStarts(page, projectsDir)

  await exportButton(page).click()
  const other = await otherOpen(page, projectsDir)
  const otherBytes = readFileSync(other)
  await expect(page.getByRole('button', { name: '✓ Reveal export' })).toBeVisible({ timeout: 90_000 })
  expect(existsSync(target)).toBe(true)
  await expect(page.getByTestId('export-save-skipped')).toHaveText(/Another project was opened/)
  expect(readFileSync(reel).equals(saved)).toBe(true) // the source project: untouched (its edit was discarded)
  expect(readFileSync(other).equals(otherBytes)).toBe(true) // the other project: not saved by the export
  await expect(page.getByTestId('export-save-error')).toHaveCount(0)
})

test('assistant export_video does not save a project opened while it exported', async ({ electronApp, appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const { reel, saved } = await arrange(page, projectsDir)
  const c = await connect(electronApp)
  const out = mkdtempSync(join(tmpdir(), 'reel-export-save-'))
  await switchProjectWhenExportStarts(page, projectsDir)

  const r = await call(c, 'export_video', { fileName: 'switched', folder: out })
  expect(r.isError, textOf(r)).toBeFalsy()
  const res = JSON.parse(textOf(r)) as { path: string; saved?: boolean; reason?: string }
  expect(existsSync(res.path)).toBe(true)
  expect(res.saved).toBe(false)
  expect(res.reason).toMatch(/Another project was opened/)
  await otherOpen(page, projectsDir)
  expect(readFileSync(reel).equals(saved)).toBe(true)
})
