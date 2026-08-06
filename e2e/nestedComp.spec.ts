/**
 * Nested compositions Stage 1: converting a layout cell to a comp, ENTERING it
 * (the whole editor re-targets — timeline shows the nested doc), editing inside
 * (real keybind), the breadcrumb exiting back out, and undo revalidating the
 * edit path instead of dangling. ARRANGE via store actions, ACT with real
 * keys/clicks, ASSERT on store + DOM.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import type { Composition, LayoutContent } from '../src/shared/project'

/** Root: one Split L|R layout at t=0 whose cell 0 holds a (fake) clip. */
async function arrangeLayoutWithCell(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { useProject } = window.__reelStores
    const s = useProject.getState()
    s.addLayoutLayer('LAY', 'split-lr', 0)
    s.updateLayoutCell('LAY', 0, { mediaId: 'no-such-media', inSec: 1, outSec: 5 })
  })
}

const rootState = (page: Page): Promise<{ layers: number; cell0: unknown; editPath: unknown[] }> =>
  page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const lay = s.project!.layers.find((l) => l.id === 'LAY')!
    return {
      layers: s.project!.layers.length,
      cell0: (lay.content as LayoutContent).cells[0],
      editPath: s.editPath
    }
  })

test('convert a cell to a comp, enter it, edit inside, breadcrumb exits', async ({
  appPage: page
}) => {
  await arrangeLayoutWithCell(page)

  // Convert + enter through the real store actions (the Stage-4 UI wraps these).
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.convertCellToComp('LAY', 0)
    s.enterComposition({ layerId: 'LAY', cellIndex: 0 })
  })

  // The editor re-targeted: the timeline now shows the seeded clip (a video
  // block over 0..4s from the cell's 1..5s trim), NOT the layout block.
  await expect(page.getByTestId('comp-breadcrumb')).toBeVisible()
  await expect(page.getByTestId('comp-breadcrumb')).toContainText('Cell 1')
  await expect(page.locator('div[title="Video"]')).toBeVisible()
  await expect(page.locator('div[title="Layout"]')).toHaveCount(0)

  // Edit INSIDE with a real keybind: T adds a text layer — to the comp.
  await page.keyboard.press('t')
  const nested = await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    const lay = s.project!.layers.find((l) => l.id === 'LAY')!
    const comp = (lay.content as LayoutContent).cells[0].comp as Composition
    return { compLayers: comp.layers.map((l) => l.content.kind), rootLayers: s.project!.layers.length }
  })
  expect(nested.compLayers).toEqual(['video', 'text']) // landed in the comp…
  expect(nested.rootLayers).toBe(1) // …not the root

  // The breadcrumb's "Timeline" hop exits back to the root: layout block again,
  // breadcrumb gone, selection cleared.
  await page.getByTestId('comp-breadcrumb').getByRole('button', { name: 'Timeline' }).click()
  await expect(page.getByTestId('comp-breadcrumb')).toHaveCount(0)
  await expect(page.locator('div[title="Layout"]')).toBeVisible()
  expect((await rootState(page)).editPath).toEqual([])
})

test('undo while inside a comp pops the edit path instead of dangling', async ({
  appPage: page
}) => {
  await arrangeLayoutWithCell(page)
  await page.evaluate(() => {
    const s = window.__reelStores.useProject.getState()
    s.convertCellToComp('LAY', 0)
    s.enterComposition({ layerId: 'LAY', cellIndex: 0 })
  })
  await expect(page.getByTestId('comp-breadcrumb')).toBeVisible()

  // One undo reverts the conversion — the comp the editor stands in no longer
  // exists, so the edit path must pop to the root (not crash / dangle).
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('comp-breadcrumb')).toHaveCount(0)
  const s = await rootState(page)
  expect(s.editPath).toEqual([])
  expect((s.cell0 as { comp?: unknown }).comp).toBeUndefined()
  // The editor is normal again: the layout block renders at the root.
  await expect(page.locator('div[title="Layout"]')).toBeVisible()
})
