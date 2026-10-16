/**
 * A render error OUTSIDE the dock panels must not blank the window.
 *
 * Regression spec (2026-10-15): a text layer whose content is just
 * `{ kind: 'text' }` (no `text`) made ChecklistModal's `buildChecklist` throw
 * ("reading 'trim'") on every render, even closed. The dock panels have their
 * own boundaries (hugeEnd.spec.ts), but the header, footer and modals had
 * none, so React unmounted the whole tree and #root went empty (the bad layer
 * is autosaved, so it stayed empty after a reload too). Each window section
 * outside the dock now has its own boundary, and the root has a last-resort one.
 *
 * Checked at the same time: unmounting the dock in a crash does NOT autosave an
 * empty layout (dockview fires no layout change on dispose, and a save already
 * pending writes the full layout). The second test keeps it that way.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const addBareTextLayer = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__reelStores.useProject.getState().addLayer({
      id: 'BARE', hidden: false, startSec: 0, endSec: 2, x: 540, y: 960, scale: 1,
      content: { kind: 'text' }
    } as never)
  })

/** Resize a panel through dockview so the live layout gets autosaved (nothing
 *  is saved at startup), and wait for that save. */
const saveALayout = async (page: Page): Promise<void> => {
  await page.evaluate(() =>
    (window.__reelStores.useDock.getState().api as unknown as {
      getPanel(id: string): { group: { api: { setSize(s: { width: number }): void } } }
    })
      .getPanel('library')
      .group.api.setSize({ width: 333 })
  )
  await expect.poll(() => savedPanelIds(page)).toHaveLength(5)
}

const savedPanelIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const raw = localStorage.getItem('dockLayout')
    return raw ? Object.keys(JSON.parse(raw).layout?.panels ?? {}) : []
  })

test('a crash outside the dock keeps the window drawn and the dock layout intact', async ({ appPage: page }) => {
  await saveALayout(page)

  await addBareTextLayer(page)
  await expect(page.getByTestId('section-error').first()).toBeVisible()
  expect(await page.evaluate(() => document.getElementById('root')!.childElementCount)).toBeGreaterThan(0)
  // The dock is outside the crashed section: still mounted with every panel
  // (the panels that draw text show their own boundary), and the header answers.
  expect(await page.evaluate(() => window.__reelStores.useDock.getState().api!.panels.length)).toBe(5)
  await expect(page.getByText('All panels closed')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '✓ Checklist' })).toBeVisible()
  // Past the 300 ms autosave debounce, the saved layout still has every panel.
  await page.waitForTimeout(800)
  expect(await savedPanelIds(page)).toHaveLength(5)

  // Undo removes the bad layer; the project change retries the crashed section.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('section-error')).toHaveCount(0)
  await expect(page.getByTestId('panel-error')).toHaveCount(0)
  await expect(page.getByTestId('timeline-scroll')).toBeVisible()
  // The checklist (the part that threw) opens and draws again.
  await page.getByRole('button', { name: '✓ Checklist' }).click()
  await expect(page.getByText('Reel checklist').first()).toBeVisible()
  await expect(page.getByTestId('section-error')).toHaveCount(0)
})

test('a crash that unmounts the dock does not autosave an empty layout', async ({ appPage: page }) => {
  await saveALayout(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // One store change that both leaves the editor (unmounting the dock) and
  // breaks what replaces it (the start screen can't draw an object message):
  // only the root boundary is left to catch it.
  const before = await page.evaluate(() => {
    const { useProject } = window.__reelStores
    const { project, filePath } = useProject.getState()
    useProject.setState({ project: null, filePath: null, launchMessage: {} as never })
    return { project, filePath }
  })
  await expect(page.getByTestId('app-error')).toBeVisible()
  await expect(page.getByTestId('timeline-scroll')).toHaveCount(0)
  // Past the 300 ms autosave debounce, the saved layout still has every panel.
  await page.waitForTimeout(800)
  expect(await savedPanelIds(page)).toHaveLength(5)

  // Getting the project back (here: put it back) retries the app; the dock
  // returns with every panel.
  await page.evaluate((b) => window.__reelStores.useProject.setState({ ...b, launchMessage: null } as never), before)
  await expect(page.getByTestId('app-error')).toHaveCount(0)
  await expect(page.getByTestId('timeline-scroll')).toBeVisible()
  await expect(page.getByText('All panels closed')).toHaveCount(0)
  expect(errors).toEqual([])
})
