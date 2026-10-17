/**
 * The New project window (docs/MEDIA-POINTERS.md "The project folder"): a name
 * and a location, then the whole structure at once — there is no untitled
 * state. A name whose folder already exists, or that Windows can't use, is
 * refused in the window.
 *
 * Uses `electronApp` + `firstWindow()` directly: `appPage` would create a
 * project before the start screen could be seen. ACT via real clicks/typing
 * with the folder picker stubbed, ASSERT on the DOM + store + disk.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

const stubFolderPicker = (app: ElectronApplication, folder: string): Promise<void> =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
  }, folder)

/** The first window with the renderer's alert/confirm made non-blocking. */
async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  page.on('dialog', (d) => void d.dismiss().catch(() => {}))
  await page.evaluate(() => {
    window.alert = (message?: unknown) => console.error('[e2e] alert:', message)
    window.confirm = (message?: string) => {
      console.error('[e2e] confirm → cancel:', message)
      return false
    }
  })
  return page
}

const openProject = (page: Page): Promise<{ id: string; name: string; filePath: string | null } | null> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    return s.project ? { id: s.project.id, name: s.project.name, filePath: s.filePath } : null
  })

test('New creates the project folder and opens it; an existing folder and an invalid name are refused in the window', async ({
  electronApp,
  projectsDir
}) => {
  test.setTimeout(60_000)
  const page = await firstWindow(electronApp)
  await expect(page.getByTestId('start-screen')).toBeVisible()
  expect(await openProject(page)).toBeNull()

  // Start screen ▸ New project… → the window, name typed, location picked.
  await page.getByTestId('start-new').click()
  const dialog = page.getByTestId('new-project-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('new-project-name').fill('My Reel')
  await stubFolderPicker(electronApp, projectsDir)
  await page.getByTestId('new-project-choose').click()
  await expect(page.getByTestId('new-project-location')).toHaveText(projectsDir)
  await page.getByTestId('new-project-create').click()

  // It opened: start screen and window gone, the File menu names it.
  await expect(page.getByTestId('start-screen')).toHaveCount(0)
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('My Reel.reel', { exact: true })).toBeVisible()
  const root = join(projectsDir, 'My Reel')
  const reel = join(root, 'My Reel.reel')
  const created = await openProject(page)
  expect(created).toMatchObject({ name: 'My Reel', filePath: reel })

  // …and the whole structure is on disk.
  expect(readdirSync(root).sort()).toEqual(
    expect.arrayContaining(['My Reel.reel', 'cache', 'generated', 'transcripts'])
  )
  for (const dir of ['generated', 'transcripts', 'cache']) expect(statSync(join(root, dir)).isDirectory()).toBe(true)
  const doc = JSON.parse(readFileSync(reel, 'utf8'))
  expect(doc).toMatchObject({ name: 'My Reel', version: 26, library: [] })
  const reelMtime = statSync(reel).mtimeMs

  // File ▸ New… again, the SAME name and location: refused inline, nothing switched.
  await page.getByRole('button', { name: 'File ▾' }).click()
  await page.getByText('New…', { exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.getByTestId('new-project-name').fill('My Reel')
  await page.getByTestId('new-project-choose').click() // the stub still answers projectsDir
  await expect(page.getByTestId('new-project-location')).toHaveText(projectsDir)
  await page.getByTestId('new-project-create').click()
  await expect(page.getByTestId('new-project-error')).toContainText('already exists')
  await expect(dialog).toBeVisible()
  expect(await openProject(page)).toEqual(created)
  expect(statSync(reel).mtimeMs).toBe(reelMtime)

  // A name Windows can't use: the reason shows and Create stays disabled.
  await page.getByTestId('new-project-name').fill('a:b')
  await expect(page.getByTestId('new-project-name-reason')).toContainText('can’t contain')
  await expect(page.getByTestId('new-project-create')).toBeDisabled()
  expect(existsSync(join(projectsDir, 'a'))).toBe(false)
  expect(await openProject(page)).toEqual(created)
})
