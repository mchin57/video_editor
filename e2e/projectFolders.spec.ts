/**
 * Project folders (docs/PROJECT-FOLDERS.md): a project owns its media, so the
 * source can move or vanish without breaking a clip, and the folder alone is
 * the project.
 *
 * ARRANGE via a real import into the unsaved (scratch) project, ACT via the real
 * Save As / New / Open store actions with the native dialogs stubbed, ASSERT on
 * the folder on disk + main's library answers.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'

const FFMPEG = resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

const stubSave = (app: ElectronApplication, filePath: string): Promise<void> =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, filePath)

const stubOpen = (app: ElectronApplication, filePath: string): Promise<void> =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
  }, filePath)

test('a saved project owns its media: the source can move or vanish, and the folder reopens intact', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-folders-'))
  mkdirSync(join(dir, 'footage'))
  const source = join(dir, 'footage', 'IMG_0001.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    source
  ])

  // --- Import into the unsaved project ------------------------------------
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, source)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().filePath)).toBeNull()

  // --- Save As: the project becomes <Name>/ with its own media ---------------
  const root = join(dir, 'Reels', 'My reel')
  await stubSave(electronApp, join(dir, 'Reels', 'My reel.reel'))
  await page.evaluate(() => window.__reelStores.useProject.getState().saveAs())
  const state = await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return { filePath: s.filePath, dirty: s.dirty, name: s.project!.name }
  })
  expect(state).toEqual({ filePath: join(root, 'My reel.reel'), dirty: false, name: 'My reel' })
  expect(await page.evaluate(() => window.api.getProjectDir())).toBe(root)

  const original = join(root, 'media', id, 'original.mp4')
  expect(statSync(original).nlink).toBe(2) // hardlinked to the source: no second copy of the bytes
  expect(statSync(original).ino).toBe(statSync(source).ino)
  expect(JSON.parse(readFileSync(join(root, 'media', id, 'asset.json'), 'utf8')).storage).toBe('link')
  expect(existsSync(join(root, 'cache', id, 'proxy.mp4'))).toBe(true)
  expect(JSON.parse(readFileSync(join(root, 'My reel.reel'), 'utf8')).mediaIds).toEqual([id])
  await expect(page.getByText('My reel.reel')).toBeVisible() // File menu label

  // --- The source moves, then disappears: the clip doesn't care -------------
  renameSync(source, join(dir, 'footage', 'renamed.mp4'))
  rmSync(join(dir, 'footage', 'renamed.mp4'))
  const [asset] = await media(page, [id])
  expect(asset.originalPath).toBe(original)
  expect(statSync(original).size).toBeGreaterThan(0)

  // --- cache/ is disposable: delete it, and loading the library rebuilds it --
  // No explicit ensureProxy: nothing in the app calls it for media already in a
  // project, so a proxy that only rebuilt on request stayed at "generating
  // preview… 0%" forever (2026-10-10, converted projects without proxies).
  rmSync(join(root, 'cache'), { recursive: true, force: true })
  expect((await media(page, [id]))[0].proxyReady).toBe(false)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  expect(existsSync(join(root, 'cache', id, 'proxy.mp4'))).toBe(true)

  // --- New, then Open the folder again -------------------------------------
  await page.evaluate(() => window.__reelStores.useProject.getState().newProjectFile())
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)).toEqual([])
  await stubOpen(electronApp, join(root, 'My reel.reel'))
  await page.evaluate(() => window.__reelStores.useProject.getState().openFile())
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.mediaIds)).toEqual([id])
  const [reopened] = await media(page, [id])
  expect(reopened.proxyReady).toBe(true)
  expect(reopened.fileName).toBe('IMG_0001.mp4')
})

test('an original overwritten in place is flagged, blocks export, and can be accepted; a missing one relinks on re-import', async ({
  electronApp,
  appPage: page
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)

  const dir = mkdtempSync(join(tmpdir(), 'reel-changed-'))
  const synth = (out: string, seconds: number): void => {
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=320x568:rate=30:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      out
    ])
  }
  const source = join(dir, 'IMG_0002.mp4')
  const retake = join(dir, 'retake.mp4')
  synth(source, 2)
  synth(retake, 3)

  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const s = window.__reelStores.useProject.getState()
    s.addMedia([asset.id])
    s.addVideoLayer('v1', asset.id, 0, asset.probe.durationSec, false)
    return asset.id
  }, source)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)

  // Overwrite the SOURCE in place (what Explorer's "Replace the file" does):
  // the project's hardlinked original changes with it.
  writeFileSync(source, readFileSync(retake))
  expect((await media(page, [id]))[0].status).toBe('changed')
  // The user comes back to the app from Explorer: the library re-checks.
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-changed')).toBeVisible()

  // Export refuses, naming the file.
  await stubSave(electronApp, join(dir, 'out.mp4'))
  const exportError = await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    try {
      await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
      return null
    } catch (e) {
      return String(e)
    }
  })
  expect(exportError).toContain('changed outside the app: IMG_0002.mp4')

  // "Use the new file": same id, new content, cache rebuilt from it.
  await page.getByTestId('media-changed').getByRole('button', { name: 'Use the new file' }).click()
  await expect(page.getByTestId('media-changed')).toHaveCount(0)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  const accepted = (await media(page, [id]))[0]
  expect(accepted.status).toBe('ok')
  expect(accepted.probe.durationSec).toBeGreaterThan(2.5) // the 3 s retake

  // The project's own original disappears: flagged missing, and re-importing
  // the same bytes from anywhere relinks it.
  const projectDir = await page.evaluate(() => window.api.getProjectDir())
  rmSync(join(projectDir, 'media', id, 'original.mp4'))
  expect((await media(page, [id]))[0].status).toBe('missing')
  await page.evaluate((p) => window.api.importPaths([p]), retake)
  expect((await media(page, [id]))[0].status).toBe('ok')
  expect(existsSync(join(projectDir, 'media', id, 'original.mp4'))).toBe(true)
})
