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

test('editing shortcuts are ignored while a timeline drag is held', async ({ appPage: page }) => {
  // Regression: Delete / Ctrl+Z / T mid-drag used to edit the project, then the drag's
  // next move overwrote the edit and its release recorded a stale undo step.
  await page.keyboard.press('t')
  const read = (): Promise<{ ids: string[]; startSec: number; past: number }> =>
    page.evaluate(() => {
      const s = window.__reelStores.useProject.getState()
      const layers = s.project!.layers
      return { ids: layers.map((l) => l.id), startSec: layers[0]?.startSec ?? -1, past: s.past.length }
    })
  const before = await read()
  expect(before.ids).toHaveLength(1)
  const box = (await page.getByTestId(`tile-layer-${before.ids[0]}`).boundingBox())!
  const y = box.y + box.height / 2

  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 4 })
  for (const key of ['Delete', 'Control+z', 't', 's', 'n']) await page.keyboard.press(key)
  const mid = await read()
  expect(mid.ids).toEqual(before.ids) // nothing deleted, undone or added
  expect(mid.past).toBe(before.past) // and no history written mid-drag
  await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 2 })
  await page.mouse.up()

  const after = await read()
  expect(after.ids).toEqual(before.ids)
  expect(after.startSec).toBeGreaterThan(0)
  expect(after.past).toBe(before.past + 1) // exactly the drag

  // Shortcuts work again after release: one Ctrl+Z undoes exactly the move.
  await page.keyboard.press('Control+z')
  expect((await read()).startSec).toBeCloseTo(before.startSec, 6)
})
