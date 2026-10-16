/**
 * Library right-click ▸ Rename… (docs/MEDIA-POINTERS.md "Rename"): the file
 * on disk and the library item are renamed together, and the project is saved
 * at once, so reopening finds the clip under its new name. A taken name is
 * refused inline with nothing changed; Escape cancels; a Missing card's
 * Rename is greyed out with the reason.
 *
 * ARRANGE via a real import into the fixture's project, ACT via a real
 * right-click + typing in the in-app dialog, ASSERT on disk, the saved `.reel`,
 * main's library answers and the DOM. The only native dialog used (File ▸
 * Open's picker, for the reopen) is stubbed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { MediaAsset } from '../src/shared/media'
import { test, expect } from './fixtures'
import { FFMPEG } from './bin'

const media = (page: Page, ids: string[]): Promise<MediaAsset[]> =>
  page.evaluate((ids) => window.api.listProjectMedia(ids), ids)

const synth = (out: string, duration: number, pattern = 'testsrc2'): void => {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${pattern}=size=320x568:rate=30:duration=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    out
  ])
}

/** Import `path` into the library and wait for its proxy. */
async function importClip(page: Page, path: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const [asset] = await window.api.importPaths([p])
    window.__reelStores.useProject.getState().addMedia([asset.id])
    return asset.id
  }, path)
  await expect.poll(async () => (await media(page, [id]))[0]?.proxyReady, { timeout: 30_000 }).toBe(true)
  return id
}

const save = (page: Page): Promise<void> => page.evaluate(() => window.__reelStores.useProject.getState().save())
const dirty = (page: Page): Promise<boolean> => page.evaluate(() => window.__reelStores.useProject.getState().dirty)

/** The saved `.reel`'s library record for `id`. */
const savedRecord = (reel: string, id: string): { fileName: string; relativePath: string; absolutePath: string } =>
  (JSON.parse(readFileSync(reel, 'utf8')) as { library: { id: string; fileName: string; relativePath: string; absolutePath: string }[] }).library.find(
    (r) => r.id === id
  )!

async function openRename(page: Page, cardName: string): Promise<void> {
  await page.getByText(cardName, { exact: true }).click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.getByTestId('ctx-rename').click()
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  await expect(page.getByTestId('rename-dialog')).toBeVisible()
}

async function stubOpen(app: ElectronApplication, reel: string): Promise<void> {
  await app.evaluate(({ dialog }, reel) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [reel] })) as typeof dialog.showOpenDialog
  }, reel)
}

test('Rename renames the file and the card, saves the .reel with the new path, and the clip reopens found', async ({
  electronApp,
  appPage: page,
  projectsDir
}) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const reel = join(root, 'E2E.reel')
  mkdirSync(join(root, 'footage'))
  synth(join(root, 'footage', 'IMG_0010.mp4'), 1)
  const id = await importClip(page, join(root, 'footage', 'IMG_0010.mp4'))
  await save(page)

  await openRename(page, 'IMG_0010.mp4')
  // The stem is editable; the extension is shown fixed beside it.
  await expect(page.getByTestId('rename-name')).toHaveValue('IMG_0010')
  await expect(page.getByTestId('rename-ext')).toHaveText('.mp4')
  await expect(page.getByTestId('rename-dialog')).toContainText('Missing until you relink')
  // An illegal name is explained live, and Rename stays off.
  await page.getByTestId('rename-name').fill('swim: drill')
  await expect(page.getByTestId('rename-reason')).toContainText('can’t contain')
  await expect(page.getByTestId('rename-submit')).toBeDisabled()
  await page.getByTestId('rename-name').fill('Swim drill')
  await page.getByTestId('rename-name').press('Enter')
  await expect(page.getByTestId('rename-dialog')).toHaveCount(0)

  // On disk, in the library, and on the card.
  const renamed = join(root, 'footage', 'Swim drill.mp4')
  expect(readdirSync(join(root, 'footage'))).toEqual(['Swim drill.mp4'])
  await expect(page.getByText('Swim drill.mp4', { exact: true })).toBeVisible()
  expect((await media(page, [id]))[0]).toMatchObject({ status: 'ok', fileName: 'Swim drill.mp4', originalPath: renamed })
  // Saved at once: the .reel names the new file, and nothing is left unsaved.
  await expect.poll(() => savedRecord(reel, id).relativePath).toBe('footage/Swim drill.mp4')
  expect(savedRecord(reel, id)).toMatchObject({ fileName: 'Swim drill.mp4', absolutePath: renamed })
  expect(await dirty(page)).toBe(false)

  // Reopen the project: the clip is found under its new name, not Missing.
  await stubOpen(electronApp, reel)
  await page.evaluate(() => window.__reelStores.useProject.getState().openFile())
  await expect(page.getByText('Swim drill.mp4', { exact: true })).toBeVisible()
  await expect(page.getByTestId('media-missing')).toHaveCount(0)
  expect((await media(page, [id]))[0]).toMatchObject({ status: 'ok', originalPath: renamed })
  expect(await dirty(page)).toBe(false)
})

test('a taken name is refused inline and changes nothing; Escape cancels', async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  const reel = join(root, 'E2E.reel')
  mkdirSync(join(root, 'footage'))
  synth(join(root, 'footage', 'IMG_0020.mp4'), 1)
  synth(join(root, 'footage', 'Taken.mp4'), 1, 'smptebars') // somebody else's file
  const taken = readFileSync(join(root, 'footage', 'Taken.mp4'))
  const id = await importClip(page, join(root, 'footage', 'IMG_0020.mp4'))
  await save(page)
  const before = readFileSync(reel, 'utf8')

  await openRename(page, 'IMG_0020.mp4')
  await page.getByTestId('rename-name').fill('taken') // Windows: the same name, whatever the case
  await page.getByTestId('rename-submit').click()
  await expect(page.getByTestId('rename-error')).toContainText('already exists')
  await expect(page.getByTestId('rename-dialog')).toBeVisible() // stays open to try another name

  expect(readdirSync(join(root, 'footage')).sort()).toEqual(['IMG_0020.mp4', 'Taken.mp4'])
  expect(readFileSync(join(root, 'footage', 'Taken.mp4')).equals(taken)).toBe(true) // never overwritten
  expect((await media(page, [id]))[0]).toMatchObject({ status: 'ok', fileName: 'IMG_0020.mp4' })
  expect(readFileSync(reel, 'utf8')).toBe(before)
  expect(await dirty(page)).toBe(false)

  // Escape closes it without renaming (and doesn't reach the app's own Escape).
  await page.getByTestId('rename-name').fill('Something else')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('rename-dialog')).toHaveCount(0)
  expect(readdirSync(join(root, 'footage')).sort()).toEqual(['IMG_0020.mp4', 'Taken.mp4'])
  await expect(page.getByText('IMG_0020.mp4', { exact: true })).toBeVisible()
  expect(await dirty(page)).toBe(false)

  // The menu itself closes on Escape and on a click elsewhere.
  await page.getByText('IMG_0020.mp4', { exact: true }).click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  await page.getByText('IMG_0020.mp4', { exact: true }).click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
})

test("a Missing card's Rename is greyed out, with the reason", async ({ appPage: page, projectsDir }) => {
  test.skip(!existsSync(FFMPEG), 'bundled ffmpeg not staged (run npm run collect-binaries)')
  test.setTimeout(120_000)
  const root = join(projectsDir, 'E2E')
  mkdirSync(join(root, 'footage'))
  synth(join(root, 'footage', 'IMG_0030.mp4'), 1)
  await importClip(page, join(root, 'footage', 'IMG_0030.mp4'))
  await save(page)

  renameSync(join(root, 'footage'), join(root, 'elsewhere'))
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('media-missing')).toBeVisible()

  await page.getByTestId('media-missing').getByText('IMG_0030.mp4', { exact: true }).click({ button: 'right' })
  const rename = page.getByTestId('ctx-rename')
  await expect(rename).toBeDisabled() // aria-disabled
  await expect(rename).toContainText('The file is missing. Relink it first.')
  await expect(page.getByTestId('ctx-reveal')).toBeDisabled()
  await rename.click({ force: true }) // inert: no dialog, the menu stays
  await expect(page.getByTestId('rename-dialog')).toHaveCount(0)
  await expect(page.getByTestId('context-menu')).toBeVisible()
})
