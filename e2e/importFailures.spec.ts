/**
 * Failed imports say so (issue #15). A zero-byte, missing or garbage file used
 * to just not appear, its reason only in main's stderr. Now the import notice
 * names each failed file with why, a good file in the same pick still imports,
 * and Dismiss (or the next import) clears it.
 *
 * ARRANGE the files on disk and stub the native Open picker to return them,
 * ACT with a real click on the header's Import button (the same mutation a
 * window drop runs), ASSERT on the notice's DOM and the project's mediaIds.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

// The shared lookup (`e2e/bin.ts`): a worktree finds the main checkout's binaries.
import { FFMPEG } from './bin'

/** The next Open picker returns `filePaths`. */
const pickNext = (app: ElectronApplication, filePaths: string[]): Promise<void> =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog
  }, filePaths)

const mediaIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project?.mediaIds ?? [])

test('a zero-byte, a missing and a garbage file are each named with why', async ({ appPage: page, electronApp, scratchDir }) => {
  const empty = join(scratchDir, 'empty clip.mp4')
  writeFileSync(empty, '')
  const missing = join(scratchDir, 'gone.mov')
  const garbage = join(scratchDir, 'garbage.mp4')
  writeFileSync(garbage, Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 256)))

  await pickNext(electronApp, [empty, missing, garbage])
  await page.getByRole('button', { name: 'Import video' }).click()

  const notice = page.getByTestId('import-failures')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText("Couldn't import 3 files")
  const rows = notice.locator('li')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('empty clip.mp4')
  await expect(rows.nth(0)).toContainText('The file is empty (0 bytes).')
  await expect(rows.nth(1)).toContainText('gone.mov')
  await expect(rows.nth(1)).toContainText('File not found.')
  await expect(rows.nth(2)).toContainText('garbage.mp4')
  await expect(rows.nth(2)).toContainText('incomplete or damaged')
  // The full path is there on hover.
  await expect(rows.nth(1)).toHaveAttribute('title', missing)
  expect(await mediaIds(page)).toEqual([])

  await page.getByTestId('import-failures-dismiss').click()
  await expect(notice).toHaveCount(0)
})

test('a good file in the same pick still imports; the next import clears the notice', async ({ appPage: page, electronApp, scratchDir }) => {
  test.skip(!existsSync(FFMPEG), 'needs resources/bin/ffmpeg (npm run collect-binaries)')
  const good = join(scratchDir, 'good.mp4')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', good
  ])
  const empty = join(scratchDir, 'empty.mp4')
  writeFileSync(empty, '')

  await pickNext(electronApp, [good, empty])
  await page.getByRole('button', { name: 'Import video' }).click()

  const notice = page.getByTestId('import-failures')
  await expect(notice).toContainText("Couldn't import 1 file")
  await expect(notice.locator('li')).toHaveCount(1)
  await expect(notice).toContainText('empty.mp4')
  await expect.poll(() => mediaIds(page).then((ids) => ids.length)).toBe(1)

  // A clean import replaces the notice with nothing.
  await pickNext(electronApp, [good])
  await page.getByRole('button', { name: 'Import video' }).click()
  await expect(notice).toHaveCount(0)
})
