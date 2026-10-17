import { test, expect } from './fixtures'

test('launches to an empty project with the idle hints showing', async ({ appPage: page }) => {
  await expect(page.getByText('Reel Editor', { exact: true })).toBeVisible()
  // Preview, timeline, and library each show their empty-state hint.
  await expect(page.getByText('Add a clip to the timeline to begin')).toBeVisible()
  await expect(page.getByText(/Drag media here/)).toBeVisible()
  await expect(page.getByText(/Drag iPhone clips here/)).toBeVisible()
  // Hermetic profile sanity: the temp data dir starts with no media.
  const layerCount = await page.evaluate(() => window.__reelStores.useProject.getState().project?.layers.length)
  expect(layerCount).toBe(0)
})
