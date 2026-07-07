/**
 * Keyboard flows through the real window keydown handler (App.tsx): T adds a
 * text layer, Ctrl+Z / Ctrl+Shift+Z walk history, Delete removes the selection.
 * DOM presence is a smoke check (the text renders in several places — stage,
 * timeline block, layers panel); the store is the ground truth for counts.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const layerCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.__reelStores.useProject.getState().project?.layers.length ?? -1)

test('T adds a text layer; undo/redo/delete flow works end to end', async ({ appPage: page }) => {
  const hook = page.getByText('Your hook here')

  await page.keyboard.press('t')
  await expect(hook.first()).toBeVisible()
  expect(await layerCount(page)).toBe(1)

  await page.keyboard.press('Control+z')
  await expect(hook).toHaveCount(0)
  expect(await layerCount(page)).toBe(0)

  await page.keyboard.press('Control+Shift+z')
  await expect(hook.first()).toBeVisible()
  expect(await layerCount(page)).toBe(1)

  await page.keyboard.press('Delete') // the restored layer is still selected
  await expect(hook).toHaveCount(0)
  expect(await layerCount(page)).toBe(0)
})
