/**
 * An export never leaves a torn file at the chosen name, nor destroys a file
 * already there (#9). It encodes to `<name>.part.mp4` and renames on success,
 * so a killed ffmpeg leaves the earlier file byte-identical and no partial.
 * Every native dialog is stubbed; nothing waits on a person.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'

const ROOT = resolve(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffprobe.exe')

/** A clip long enough that the export is still encoding when we kill it. */
async function arrange(page: Page, projectsDir: string, durationSec: number): Promise<void> {
  const source = join(projectsDir, 'E2E', 'clip.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=320x568:rate=30:duration=${durationSec}`,
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
      timeout: 60_000
    })
    .toBe(true)
}

async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, filePath)
}

/** Kill only THIS app's ffmpeg children (never a dev app's or anyone else's). */
async function killAppFfmpeg(app: ElectronApplication): Promise<number> {
  const pid = await app.evaluate(() => process.pid)
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `$p = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='ffmpeg.exe'"); ` +
      `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; $p.Count`
  ])
  return Number(out.toString().trim())
}

const exportButton = (page: Page): ReturnType<Page['getByRole']> => page.getByRole('button', { name: 'Export', exact: true })
const SENTINEL = Buffer.from('an earlier export the user wants to keep')

test('a killed export leaves the existing file at that name untouched and no partial', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG) || process.platform !== 'win32', 'bundled ffmpeg not staged / Windows-only kill helper')
  test.setTimeout(180_000)
  await arrange(page, projectsDir, 60)
  const dir = mkdtempSync(join(tmpdir(), 'reel-export-atomic-'))
  const target = join(dir, 'keep.mp4')
  const part = join(dir, 'keep.part.mp4')
  writeFileSync(target, SENTINEL)
  await stubSaveDialog(electronApp, target)

  await exportButton(page).click()
  // The encode has started: it writes the partial, never the final name.
  await expect.poll(() => existsSync(part), { timeout: 60_000 }).toBe(true)
  expect(readFileSync(target).equals(SENTINEL)).toBe(true)

  expect(await killAppFfmpeg(electronApp)).toBeGreaterThan(0)
  await expect(page.getByText(/^Export failed:/)).toBeVisible({ timeout: 30_000 })
  expect(readFileSync(target).equals(SENTINEL)).toBe(true)
  expect(existsSync(part)).toBe(false)
})

test('a finished export replaces the file at that name with a playable mp4', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  await arrange(page, projectsDir, 2)
  const dir = mkdtempSync(join(tmpdir(), 'reel-export-atomic-'))
  const target = join(dir, 'replace.mp4')
  writeFileSync(target, SENTINEL)
  await stubSaveDialog(electronApp, target)

  await exportButton(page).click()
  await expect(page.getByRole('button', { name: '✓ Reveal export' })).toBeVisible({ timeout: 90_000 })
  expect(existsSync(join(dir, 'replace.part.mp4'))).toBe(false)
  const dur = Number(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target]).toString().trim()
  )
  expect(dur).toBeGreaterThan(1.5)
})
