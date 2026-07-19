/**
 * Multi-clip layouts: the toolbar creates a layout layer, the timeline grows a
 * Layout lane with its block, the Inspector reshapes the arrangement, and the
 * preview shows the (empty) cell slots while selected. ARRANGE/ASSERT via
 * store, ACT via real clicks and drags.
 */
import { test, expect } from './fixtures'
import type { LayoutContent } from '../src/shared/project'

test('Format menu adds a layout and switches presets; block drags in time', async ({
  appPage: page
}) => {
  // The layout tools live in the header's FORMAT menu — open it, then create
  // via the real button. The dropdown stays open for the follow-up edits.
  await page.getByRole('button', { name: 'Format ▾' }).click()
  await page.getByTitle('Add a multi-clip layout (split screen / panels) at the playhead').click()

  const state = (): Promise<{ startSec: number; endSec: number; c: LayoutContent }> =>
    page.evaluate(() => {
      const l = window.__reelStores.useProject.getState().project!.layers[0]
      return { startSec: l.startSec, endSec: l.endSec, c: l.content as LayoutContent }
    })
  let s = await state()
  expect(s.c.kind).toBe('layout')
  expect(s.c.presetId).toBe('split-lr')
  expect(s.c.cells).toHaveLength(2)

  // The Layout lane bubble and the block appear.
  await expect(page.getByText('Layout', { exact: true }).first()).toBeVisible()
  const block = page.locator('div[title="Layout"]')
  await expect(block).toBeVisible()

  // The preview outlines the empty cell slots while the layer is selected.
  await expect(page.locator('[data-resizebox] .border-dashed')).toHaveCount(2)

  // Reshape to the 2×2 grid via the menu's preset buttons.
  await page.getByTitle('2×2 grid (4 cells)').click()
  s = await state()
  expect(s.c.presetId).toBe('grid-2x2')
  expect(s.c.cells).toHaveLength(4)
  await expect(page.locator('[data-resizebox] .border-dashed')).toHaveCount(4)

  // Close the menu (toggle) so its dropdown can't sit over the timeline block.
  await page.getByRole('button', { name: 'Format ▾' }).click()

  // Drag the block 2s right — a plain move, window preserved.
  const scale = await page.evaluate(() => Number(localStorage.getItem('timelinePps')) || 48)
  const bb = (await block.boundingBox())!
  const gx = bb.x + bb.width / 2
  const gy = bb.y + bb.height / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 2 * scale, gy, { steps: 5 })
  await page.mouse.up()
  const after = await state()
  expect(after.startSec).toBeGreaterThan(1.5)
  expect(after.startSec).toBeLessThan(2.5)
  expect(after.endSec - after.startSec).toBeCloseTo(s.endSec - s.startSec, 1)
})
