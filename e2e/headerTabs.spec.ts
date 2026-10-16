/**
 * The header stays one line while a job's progress bar shows (TODO ▸ Bugs ▸
 * "Header tabs wrap to two lines while a progress bar is showing"): the menu
 * labels never wrap; the job indicator truncates instead.
 *
 * ARRANGE a running job via the real `applyJobEvent`, ASSERT on the header's
 * height and each menu button's height, at the default and a narrow width.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const headerHeight = (page: Page): Promise<number> =>
  page.locator('header').first().evaluate((el) => el.getBoundingClientRect().height)

/** Every header button reads as one line (none taller than the shortest twice over). */
const buttonsOneLine = (page: Page): Promise<boolean> =>
  page
    .locator('header')
    .first()
    .evaluate((el) => {
      const hs = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height).filter((h) => h > 0)
      return Math.max(...hs) < Math.min(...hs) * 1.8
    })

test('header tabs stay on one line while a progress bar shows, also at a narrow width', async ({
  appPage: page,
  electronApp
}) => {
  for (const width of [1400, 1000]) {
    await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 900), width)
    await page.evaluate(() => window.__reelStores.useEditor.setState({ jobs: {} }))
    await expect(page.getByTestId('jobs-indicator')).toHaveCount(0)
    const before = await headerHeight(page)

    await page.evaluate(() =>
      window.__reelStores.useEditor.getState().applyJobEvent({
        id: 'j1',
        type: 'proxy',
        status: 'running',
        progress: 0.4,
        label: 'Generating preview for a_clip_with_a_rather_long_file_name_from_the_phone.mp4',
        cancelable: true,
        startedAt: Date.now() - 5000
      })
    )
    await expect(page.getByTestId('jobs-indicator')).toBeVisible()
    expect(await headerHeight(page)).toBe(before)
    expect(await buttonsOneLine(page)).toBe(true)
  }
})
