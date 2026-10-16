/**
 * Media pointers (docs/MEDIA-POINTERS.md): a library item points at its
 * original where it is — relative path first, absolute second, fingerprint-
 * checked — and only Save writes the library into the .reel.
 *
 * ARRANGE via a real import into the fixture's project (`E2E/` in the test's
 * own projects dir), ACT via the real store actions with the native dialogs
 * stubbed, ASSERT on the files on disk + main's library answers + the DOM.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset, MediaRecord } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

const library = (reel: string): MediaRecord[] => JSON.parse(readFileSync(reel, 'utf8')).library

const stubOpen = (app: ElectronApplication, filePath: string): Promise<void> =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
  }, filePath)

const synth = (out: string): void => {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    out
  ])
}

/** Import `path` into the open project and wait for its proxy. */
async function importClip(page: Page, path: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    const s = window.__reelStores.useProject.getState()
    s.addMedia([asset.id])
    s.addVideoLayer('v1', asset.id, 0, asset.probe.durationSec, false)
    return asset.id
  }, path)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  return id
}

const save = (page: Page): Promise<void> => page.evaluate(() => window.__reelStores.useProject.getState().save())
const dirty = (page: Page): Promise<boolean> => page.evaluate(() => window.__reelStores.useProject.getState().dirty)

test('a library item points at its original, and only Save writes it into the .reel', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const reel = join(root, 'E2E.reel')
  for (const dir of ['generated', 'transcripts', 'cache']) expect(existsSync(join(root, dir))).toBe(true)

  mkdirSync(join(root, 'footage'))
  const source = join(root, 'footage', 'IMG_0001.mp4')
  synth(source)
  const id = await importClip(page, source)

  // Pointed at, not copied or linked.
  expect(statSync(source).nlink).toBe(1)
  expect(existsSync(join(root, 'media'))).toBe(false)
  expect((await media(page, [id]))[0].originalPath).toBe(source)

  // Unsaved: the autosave carries the library; the .reel doesn't.
  expect(await dirty(page)).toBe(true)
  expect(library(reel)).toEqual([])
  await expect.poll(() => existsSync(join(root, 'autosave.json'))).toBe(true)

  await save(page)
  expect(await dirty(page)).toBe(false)
  const [record] = library(reel)
  expect(record).toMatchObject({ id, fileName: 'IMG_0001.mp4', relativePath: 'footage/IMG_0001.mp4', absolutePath: source })
  expect(record.fingerprint.size).toBe(statSync(source).size)
})

test('a copied project finds its own footage by relative path; the fixed absolute path waits for Save', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  mkdirSync(join(root, 'footage'))
  const source = join(root, 'footage', 'IMG_0002.mp4')
  synth(source)
  const id = await importClip(page, source)
  await save(page)

  // The project folder, footage inside it, carried somewhere else (a copy, so
  // nothing the open app holds has to move).
  const moved = join(projectsDir, 'Moved', 'E2E')
  cpSync(root, moved, { recursive: true })
  await stubOpen(electronApp, join(moved, 'E2E.reel'))
  await page.evaluate(() => window.__reelStores.useProject.getState().openFile())

  const movedSource = join(moved, 'footage', 'IMG_0002.mp4')
  const [asset] = await media(page, [id])
  expect(asset.status).toBe('ok')
  expect(asset.originalPath).toBe(movedSource) // relative wins over the still-valid absolute path
  expect(await dirty(page)).toBe(true) // the absolute path changed — in memory
  expect(library(join(moved, 'E2E.reel'))[0].absolutePath).toBe(source) // …not yet on disk
  await save(page)
  expect(library(join(moved, 'E2E.reel'))[0].absolutePath).toBe(movedSource)
})

test('renamed footage shows Missing, blocks export, and Relink points it at the file', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  mkdirSync(join(root, 'footage'))
  const source = join(root, 'footage', 'IMG_0003.mp4')
  synth(source)
  const id = await importClip(page, source)
  await save(page)

  const renamed = join(root, 'footage', 'renamed.mp4')
  renameSync(source, renamed)
  // The user comes back to the app from Explorer: the library re-checks.
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-missing')).toBeVisible()
  expect((await media(page, [id]))[0].status).toBe('missing')

  // Answer the export's Save dialog (it comes before the media check).
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, join(projectsDir, 'out.mp4'))
  const exportError = await page.evaluate(async () => {
    const p = window.__reelStores.useProject.getState().project!
    try {
      await window.api.exportProject(p, { preset: p.preset, preferNvenc: false })
      return null
    } catch (e) {
      return String(e)
    }
  })
  expect(exportError).toContain('missing: IMG_0003.mp4')

  await stubOpen(electronApp, renamed)
  await page.getByTestId('media-missing').getByRole('button', { name: 'Relink…' }).click()
  await expect(page.getByTestId('media-missing')).toHaveCount(0)
  const [asset] = await media(page, [id])
  expect(asset).toMatchObject({ status: 'ok', originalPath: renamed, relativePath: 'footage/renamed.mp4' })
  expect(asset.fileName).toBe('IMG_0003.mp4') // the library keeps the imported name
  await expect.poll(() => dirty(page)).toBe(true) // relinking is an unsaved change
})
