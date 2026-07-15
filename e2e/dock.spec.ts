/**
 * Dockable panel system: closing a panel via its tab, reopening it from the
 * View menu, and Reset layout restoring the default arrangement. Tab-drag
 * re-docking is covered by the manual smoke checklist (HTML5 dnd is not
 * reliable under Playwright).
 */

import { test, expect } from './fixtures'

// The five manifest panels, by tab title (keep in sync with lib/dockLayout.ts).
const ALL_TABS = ['Preview', 'Library', 'Layers', 'Inspector', 'Timeline']

test('close a panel via its tab, reopen it from the View menu', async ({ appPage: page }) => {
  const timelineTab = page.locator('.dv-default-tab', { hasText: 'Timeline' })
  await expect(timelineTab).toBeVisible()

  // ACT: real click on the tab's close button.
  await timelineTab.hover()
  await timelineTab.locator('.dv-default-tab-action').click()

  // ASSERT: DOM gone + store agrees.
  await expect(timelineTab).toHaveCount(0)
  expect(
    await page.evaluate(() => window.__reelStores.useDock.getState().openPanels.timeline)
  ).toBe(false)

  // ACT: reopen from the View menu.
  await page.getByRole('button', { name: 'View ▾' }).click()
  await page.getByRole('button', { name: 'Timeline' }).click()

  // ASSERT: tab is back, store agrees.
  await expect(page.locator('.dv-default-tab', { hasText: 'Timeline' })).toBeVisible()
  expect(
    await page.evaluate(() => window.__reelStores.useDock.getState().openPanels.timeline)
  ).toBe(true)
})

test('reset layout restores all panels and rewrites the saved layout', async ({
  appPage: page
}) => {
  // ARRANGE: close two panels through the store (same actions the UI calls).
  await page.evaluate(() => {
    const dock = window.__reelStores.useDock.getState()
    dock.closePanel('layers')
    dock.closePanel('inspector')
  })
  await expect(page.locator('.dv-default-tab', { hasText: 'Inspector' })).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('dockLayout'))

  // ACT: View ▾ → Reset layout.
  await page.getByRole('button', { name: 'View ▾' }).click()
  await page.getByRole('button', { name: 'Reset layout' }).click()

  // ASSERT: every manifest panel has a visible tab again, and the layout was
  // re-persisted under the versioned envelope.
  for (const title of ALL_TABS) {
    await expect(page.locator('.dv-default-tab', { hasText: title })).toBeVisible()
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dockLayout') ?? 'null'))
  expect(saved?.v).toBe(1)
  expect(Object.keys(saved?.layout?.panels ?? {}).sort()).toEqual(
    ['inspector', 'layers', 'library', 'preview', 'timeline']
  )
})
