/**
 * Regressions for the chaos-QA nits of 2026-10-15 (#19): exports can be
 * canceled and their notes belong to the project they were posted for; an
 * unwritable folder fails up front in plain words; a typing session in the Text
 * box is one undo step; a still renamed `.mp4` imports as a still; the Layers
 * checkbox is named for what "checked" means; an over-long project name says why
 * Create is disabled.
 *
 * ARRANGE via real imports + store actions (every native dialog stubbed), ACT
 * via real clicks and typing, ASSERT on DOM, store and disk.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const media = (page: Page, id: string): Promise<MediaAsset> =>
  page.evaluate(async (id) => (await window.api.listProjectMedia([id]))[0], id)

/** Import `path` into the open project and wait for its proxy. */
async function importReady(page: Page, path: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
  await expect.poll(async () => (await media(page, id))?.proxyReady, { timeout: 60_000 }).toBe(true)
  return id
}

/** A `sec`-long clip in the project folder, imported and placed at 0. */
async function placedClip(page: Page, projectsDir: string, sec: number): Promise<string> {
  const source = join(projectsDir, 'E2E', `clip${sec}.mp4`)
  execFileSync(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x568:rate=30:duration=${sec}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    source
  ])
  const id = await importReady(page, source)
  await page.evaluate(
    ({ id, sec }) => window.__reelStores.useProject.getState().addVideoLayer('v1', id, 0, sec, false),
    { id, sec }
  )
  return id
}

/** Answer main's Save dialog with `filePath`. */
const stubSaveDialog = (app: ElectronApplication, filePath: string): Promise<void> =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, filePath)

const exportButton = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('button', { name: 'Export', exact: true })

test('Cancel stops a running export: no file, nothing saved, a "canceled" note instead of a failure', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(180_000)
  await placedClip(page, projectsDir, 90) // long enough to still be encoding when Cancel lands
  await page.evaluate(() => window.__reelStores.useProject.getState().save())
  const reel = join(projectsDir, 'E2E', 'E2E.reel')
  await page.evaluate(() => window.__reelStores.useProject.getState().setPreset('square')) // an unsaved edit
  const saved = readFileSync(reel)
  const out = mkdtempSync(join(tmpdir(), 'reel-export-cancel-'))
  const target = join(out, 'canceled.mp4')
  await stubSaveDialog(electronApp, target)

  await exportButton(page).click()
  const cancel = page.getByRole('button', { name: /^Cancel Export/ }).first()
  await expect(cancel).toBeVisible({ timeout: 30_000 })
  await cancel.click()

  await expect(page.getByTestId('export-canceled')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/^Export failed:/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '✓ Reveal export' })).toHaveCount(0)
  await expect(exportButton(page)).toBeEnabled()
  const status = await page.evaluate(
    () => Object.values(window.__reelStores.useEditor.getState().jobs).find((j) => j.type === 'export')?.status
  )
  expect(status).toBe('canceled')
  expect(existsSync(target)).toBe(false)
  expect(existsSync(join(out, 'canceled.part.mp4'))).toBe(false)
  expect(readFileSync(reel).equals(saved)).toBe(true) // a canceled export saves nothing
})

test("an export's Reveal goes away once another project is opened", async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  await placedClip(page, projectsDir, 2)
  await stubSaveDialog(electronApp, join(mkdtempSync(join(tmpdir(), 'reel-export-notes-')), 'done.mp4'))
  await exportButton(page).click()
  const reveal = page.getByRole('button', { name: '✓ Reveal export' })
  await expect(reveal).toBeVisible({ timeout: 90_000 })

  await page.evaluate((dir) => window.__reelStores.useProject.getState().createProject('Other', dir), projectsDir)
  await expect.poll(() => page.evaluate(() => window.__reelStores.useProject.getState().project?.name)).toBe('Other')
  await expect(reveal).toHaveCount(0)
})

test('an export into a folder it may not write fails up front, in plain words', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  // A folder a normal (non-elevated) user can't create files in.
  const locked = 'C:\\Program Files'
  const probe = join(locked, `.reel-e2e-${process.pid}`)
  let writable = true
  try {
    writeFileSync(probe, '', { flag: 'wx' })
    rmSync(probe, { force: true })
  } catch {
    writable = false
  }
  test.skip(writable, `${locked} is writable here (elevated run)`)

  await placedClip(page, projectsDir, 2)
  await stubSaveDialog(electronApp, join(locked, 'reel-e2e.mp4'))
  await exportButton(page).click()
  const failed = page.getByText(/^Export failed:/)
  await expect(failed).toBeVisible({ timeout: 30_000 })
  const text = (await failed.getAttribute('title')) ?? ''
  expect(text).toContain(`Can't write to ${locked}: permission denied`)
  expect(text).not.toContain('ffmpeg exited')
})

test('the Text box: one typing session is one undo step', async ({ appPage: page }) => {
  await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    useProject.getState().addLayer({
      id: 'T1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      content: {
        kind: 'text',
        text: 'HELLO',
        fontFamily: 'inter',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
    useUi.getState().selectLayer('T1')
  })
  const text = (): Promise<string> =>
    page.evaluate(() => (window.__reelStores.useProject.getState().project!.layers[0].content as { text: string }).text)
  const box = page.getByRole('textbox', { name: 'Text' })
  await box.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' WORLD')
  expect(await text()).toBe('HELLO WORLD') // the preview follows every key
  await box.blur()

  // THE BUG: Undo took back one character ("HELLO WORL").
  await page.keyboard.press('Control+z')
  expect(await text()).toBe('HELLO')
  await page.keyboard.press('Control+y')
  expect(await text()).toBe('HELLO WORLD')
})

test('a JPEG renamed .mp4 imports and places as a still, not a 0:00 video', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const jpg = join(projectsDir, 'E2E', 'photo.jpg')
  execFileSync(FFMPEG, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x480',
    '-frames:v',
    '1',
    jpg
  ])
  const renamed = join(projectsDir, 'E2E', 'photo.mp4')
  writeFileSync(renamed, readFileSync(jpg))
  const id = await importReady(page, renamed)
  expect((await media(page, id)).kind).toBe('image')

  await page
    .getByRole('button', { name: /^photo\.mp4 / })
    .getByTitle('Add image at the playhead')
    .click()
  const layer = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0])
  expect(layer.content.kind).toBe('image')
  expect(layer.endSec - layer.startSec).toBeGreaterThanOrEqual(1) // a still's default length, not 0.1 s
})

test('the Layers checkbox is named "Visible" and is checked while the layer shows', async ({ appPage: page }) => {
  await page.evaluate(() => {
    window.__reelStores.useProject.getState().addLayer({
      id: 'T1',
      hidden: false,
      startSec: 0,
      endSec: 4,
      x: 540,
      y: 960,
      scale: 1,
      content: {
        kind: 'text',
        text: 'HELLO',
        fontFamily: 'inter',
        fontSizePx: 90,
        color: '#ffffff',
        pill: { enabled: false, color: '#000000cc', padPx: 18 }
      }
    })
  })
  const box = page.getByRole('checkbox', { name: 'Visible' })
  await expect(box).toBeChecked()
  await box.click()
  await expect(box).not.toBeChecked()
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers[0].hidden)).toBe(true)
})

test('New project: an over-long name says why Create is disabled', async ({ appPage: page }) => {
  await page.getByRole('button', { name: 'File ▾' }).click()
  await page.getByText('New…', { exact: true }).click()
  await expect(page.getByTestId('new-project-dialog')).toBeVisible()
  await page.getByTestId('new-project-name').click()
  await page.keyboard.type('x'.repeat(120))
  await expect(page.getByTestId('new-project-create')).toBeDisabled()
  await expect(page.getByTestId('new-project-name-reason')).toBeVisible()
  await expect(page.getByTestId('new-project-name-reason')).toContainText('100 characters')
})
