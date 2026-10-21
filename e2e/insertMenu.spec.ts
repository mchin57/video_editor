/**
 * The header's Insert menu (right after File) is where new text, captions and
 * graphics tiles come from; the timeline toolbar no longer has ＋ Text /
 * ＋ Caption. Insert ▸ Graphics drops an empty tile into its own Graphics lane
 * and opens the drawing tools in the Inspector.
 *
 * ARRANGE via the stores, ACT via the real menu, ASSERT on store + DOM.
 */
import { test, expect } from './fixtures'

test('Insert sits right after File; the toolbar has no add-text / add-caption buttons', async ({ appPage: page }) => {
  const labels = await page
    .locator('header')
    .first()
    .evaluate((el) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? ''))
  const file = labels.findIndex((l) => l.startsWith('File'))
  expect(file).toBeGreaterThanOrEqual(0)
  expect(labels[file + 1]).toBe('Insert ▾')
  await expect(page.getByRole('button', { name: '＋ Text' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '＋ Caption' })).toHaveCount(0)
})

test('Insert ▸ Text adds a selected text layer at the playhead', async ({ appPage: page }) => {
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(1.5))
  await page.getByTestId('insert-menu').click()
  await page.getByTestId('insert-text').click()
  const { layer, sel } = await page.evaluate(() => {
    const { useProject, useUi } = window.__reelStores
    return { layer: useProject.getState().project!.layers.at(-1)!, sel: useUi.getState().selectedLayerId }
  })
  expect(layer.content.kind).toBe('text')
  expect(layer.startSec).toBeCloseTo(1.5)
  expect(sel).toBe(layer.id)
  await expect(page.getByTestId('inspector-kind')).toHaveText('Text layer')
})

test('Insert ▸ Graphics adds an empty tile in a Graphics lane and opens the drawing tools', async ({
  appPage: page
}) => {
  await page.evaluate(() => window.__reelStores.usePlayback.getState().setTime(2))
  // No graphics yet: no Graphics lane.
  await expect(page.getByTestId('lane-graphics')).toHaveCount(0)
  await page.getByTestId('insert-menu').click()
  await page.getByTestId('insert-graphics').click()
  const layer = await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.at(-1)!)
  expect(layer.content).toEqual({ kind: 'graphics', marks: [] })
  expect(layer.startSec).toBeCloseTo(2)
  expect(layer.endSec).toBeCloseTo(5)
  await expect(page.getByTestId('lane-graphics')).toBeVisible()
  await expect(page.getByTestId(`tile-layer-${layer.id}`)).toBeVisible()
  await expect(page.getByTestId('inspector-kind')).toHaveText('Graphics layer')
  for (const t of ['arrow', 'line', 'rect', 'ellipse', 'angle']) {
    await expect(page.getByTestId(`graphics-tool-${t}`)).toBeVisible()
  }
  // One undo step takes it away again.
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => window.__reelStores.useProject.getState().project!.layers.length)).toBe(0)
})
